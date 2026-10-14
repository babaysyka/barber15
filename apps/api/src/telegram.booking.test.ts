import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "./routes.js";
import { prisma } from "./prisma.js";
import { signInitData } from "./telegram.js";

const token = "123456:stage6-booking";
const phone = "+998901110201";
const telegramId = "9004242";

function initData() {
  return signInitData(token, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(telegramId), first_name: "Мини", last_name: "Апп" }),
  });
}

async function cleanup() {
  await prisma.booking.deleteMany({ where: { client: { phone } } });
  await prisma.client.deleteMany({ where: { OR: [{ phone }, { telegramId }] } });
}

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("Mini App создаёт запись от Telegram-пользователя и видит её в своих записях", async () => {
  process.env.TELEGRAM_BOT_TOKEN = token;
  await cleanup();
  const app = buildApp();
  try {
    const signed = initData();
    const auth = await app.inject({
      method: "POST",
      url: "/api/v1/telegram/auth",
      payload: { initData: signed },
    });
    assert.equal(auth.statusCode, 200);
    assert.equal((auth.json() as { user: { firstName: string }; client: null }).user.firstName, "Мини");
    assert.equal((auth.json() as { client: null }).client, null);

    const slots = await app.inject({
      method: "GET",
      url: "/api/v1/availability?serviceIds=cut&barberId=aziz&date=2026-10-20",
    });
    const open = (slots.json() as { durationMin: number; slots: { startsAt: string }[] }).slots;
    const separated: { startsAt: string }[] = [];
    let nextFree = 0;
    const durationMin = (slots.json() as { durationMin: number }).durationMin;
    for (const slot of open) {
      const start = new Date(slot.startsAt).getTime();
      if (start >= nextFree) {
        separated.push(slot);
        nextFree = start + durationMin * 60_000;
      }
      if (separated.length === 2) {
        break;
      }
    }
    assert.equal(separated.length, 2);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/bookings",
      headers: { "x-telegram-init-data": signed },
      payload: {
        serviceIds: ["cut"],
        barberId: "aziz",
        startsAt: separated[0].startsAt,
        client: { name: "Мини Апп", phone },
      },
    });
    assert.equal(created.statusCode, 201);
    const manageToken = (created.json() as { booking: { manageToken: string } }).booking.manageToken;

    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/me/bookings",
      headers: { "x-telegram-init-data": signed },
    });
    assert.equal(mine.statusCode, 200);
    const rows = (mine.json() as { bookings: { manageToken: string; status: string }[] }).bookings;
    assert.equal(rows.some((row) => row.manageToken === manageToken), true);

    const saved = await prisma.booking.findUnique({ where: { manageToken } });
    assert.equal(saved?.source, "telegram");

    const taken = await app.inject({
      method: "POST",
      url: "/api/v1/bookings",
      headers: { "x-telegram-init-data": signed },
      payload: {
        serviceIds: ["cut"],
        barberId: "aziz",
        startsAt: separated[0].startsAt,
        client: { name: "Мини Апп", phone },
      },
    });
    assert.equal(taken.statusCode, 409);
    assert.equal((taken.json() as { code: string }).code, "SLOT_TAKEN");

    const moved = await app.inject({
      method: "POST",
      url: `/api/v1/bookings/${manageToken}/reschedule`,
      payload: { startsAt: separated[1].startsAt },
    });
    assert.equal(moved.statusCode, 200);

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/bookings/${manageToken}/cancel`,
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal((cancelled.json() as { booking: { status: string } }).booking.status, "cancelled");

    const forged = await app.inject({
      method: "GET",
      url: "/api/v1/me/bookings",
      headers: { "x-telegram-init-data": `${signed}x` },
    });
    assert.equal(forged.statusCode, 401);
  } finally {
    await app.close();
  }
});
