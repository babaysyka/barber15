import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "./routes.js";
import { prisma } from "./prisma.js";
import { dateKeyInZone, zonedTimeToUtc } from "./slots.js";

const phones = ["+998900000091", "+998900000092", "+998900000093"];

async function cleanup() {
  await prisma.booking.deleteMany({ where: { client: { phone: { in: phones } } } });
  await prisma.client.deleteMany({ where: { phone: { in: phones } } });
  await prisma.timeOff.deleteMany({ where: { note: "stage5-test" } });
}

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("time_off закрывает день, отмена освобождает слот, гонка оставляет одну запись", async () => {
  await cleanup();
  const app = buildApp();
  try {
  await runRace(app);
  } finally {
    await app.close();
  }
});

async function runRace(app: ReturnType<typeof buildApp>) {
  const today = dateKeyInZone(Date.now(), "Asia/Tashkent");
  const [year, month, day] = today.split("-").map(Number);
  const later = new Date(Date.UTC(year, month - 1, day + 20));
  const blockedDate = `${later.getUTCFullYear()}-${String(later.getUTCMonth() + 1).padStart(2, "0")}-${String(later.getUTCDate()).padStart(2, "0")}`;

  const timeOff = await prisma.timeOff.create({
    data: {
      barberId: "aziz",
      startsAt: new Date(zonedTimeToUtc(blockedDate, "00:00", "Asia/Tashkent")),
      endsAt: new Date(zonedTimeToUtc(blockedDate, "23:00", "Asia/Tashkent")),
      type: "day_off",
      note: "stage5-test",
    },
  });

  const blocked = await app.inject({
    method: "GET",
    url: `/api/v1/availability?serviceIds=cut&barberId=aziz&date=${blockedDate}`,
  });
  assert.equal(blocked.statusCode, 200);
  assert.equal((blocked.json() as { slots: unknown[] }).slots.length, 0);
  await prisma.timeOff.delete({ where: { id: timeOff.id } });

  const opened = await app.inject({
    method: "GET",
    url: `/api/v1/availability?serviceIds=cut&barberId=aziz&date=${blockedDate}`,
  });
  const openedBody = opened.json() as { durationMin: number; slots: { startsAt: string }[] };
  const separated: { startsAt: string }[] = [];
  let nextFree = 0;
  for (const slot of openedBody.slots) {
    const start = new Date(slot.startsAt).getTime();
    if (start >= nextFree) {
      separated.push(slot);
      nextFree = start + openedBody.durationMin * 60_000;
    }
    if (separated.length === 3) {
      break;
    }
  }
  assert.equal(separated.length, 3, "нужны три непересекающихся окна");
  const [first, second, third] = separated;

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/bookings",
    payload: {
      serviceIds: ["cut"],
      barberId: "aziz",
      startsAt: first.startsAt,
      client: { name: "Тест Один", phone: phones[0] },
    },
  });
  assert.equal(created.statusCode, 201);
  const token = (created.json() as { booking: { manageToken: string } }).booking.manageToken;

  const taken = await app.inject({
    method: "POST",
    url: "/api/v1/bookings",
    payload: {
      serviceIds: ["cut"],
      barberId: "aziz",
      startsAt: first.startsAt,
      client: { name: "Тест Два", phone: phones[1] },
    },
  });
  assert.equal(taken.statusCode, 409);
  assert.equal((taken.json() as { code: string }).code, "SLOT_TAKEN");

  const [left, right] = await Promise.all([
    app.inject({
      method: "POST",
      url: "/api/v1/bookings",
      payload: {
        serviceIds: ["cut"],
        barberId: "aziz",
        startsAt: second.startsAt,
        client: { name: "Гонка А", phone: phones[1] },
      },
    }),
    app.inject({
      method: "POST",
      url: "/api/v1/bookings",
      payload: {
        serviceIds: ["cut"],
        barberId: "aziz",
        startsAt: second.startsAt,
        client: { name: "Гонка Б", phone: phones[2] },
      },
    }),
  ]);
  const codes = [left.statusCode, right.statusCode].sort((a, b) => a - b);
  assert.deepEqual(codes, [201, 409]);

  const moved = await app.inject({
    method: "POST",
    url: `/api/v1/bookings/${token}/reschedule`,
    payload: { startsAt: third.startsAt },
  });
  assert.equal(moved.statusCode, 200);
  assert.equal((moved.json() as { booking: { startsAt: string } }).booking.startsAt, new Date(third.startsAt).toISOString());

  const cancelled = await app.inject({
    method: "POST",
    url: `/api/v1/bookings/${token}/cancel`,
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal((cancelled.json() as { booking: { status: string; canChange: boolean } }).booking.status, "cancelled");
  assert.equal((cancelled.json() as { booking: { canChange: boolean } }).booking.canChange, false);

  const again = await app.inject({
    method: "POST",
    url: "/api/v1/bookings",
    payload: {
      serviceIds: ["cut"],
      barberId: "any",
      startsAt: third.startsAt,
      client: { name: "После отмены", phone: phones[0] },
    },
  });
  assert.equal(again.statusCode, 201);
}
