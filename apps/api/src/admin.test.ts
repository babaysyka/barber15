import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "./routes.js";
import { resetLoginLimits } from "./adminAuth.js";
import { hashPassword } from "./password.js";
import { prisma } from "./prisma.js";

const login = "stage9";
const password = "stage9-pass";
const serviceId = "stage9svc";
const barberId = "stage9bar";
const phone = "+998901110901";

process.env.ADMIN_SESSION_SECRET = "stage9-session-secret-value";

function cookieFrom(header: string | string[] | undefined) {
  const line = Array.isArray(header) ? header[0] : header;
  assert.ok(line);
  return line.split(";")[0];
}

async function cleanup() {
  await prisma.review.deleteMany({ where: { barberId } });
  await prisma.booking.deleteMany({ where: { OR: [{ barberId }, { client: { phone } }] } });
  await prisma.client.deleteMany({ where: { phone } });
  await prisma.timeOff.deleteMany({ where: { note: "stage9" } });
  await prisma.barber.deleteMany({ where: { id: barberId } });
  await prisma.service.deleteMany({ where: { id: serviceId } });
  await prisma.adminUser.deleteMany({ where: { login } });
}

after(async () => {
  await cleanup();
  resetLoginLimits();
  await prisma.$disconnect();
});

test("админка пускает по cookie и меняет каталог, график и запись", async () => {
  resetLoginLimits();
  await cleanup();
  await prisma.adminUser.create({
    data: { login, passwordHash: await hashPassword(password) },
  });
  const app = buildApp();

  const closed = await app.inject({ method: "GET", url: "/api/v1/admin/bookings?date=2026-10-20" });
  assert.equal(closed.statusCode, 401);

  const wrong = await app.inject({
    method: "POST",
    url: "/api/v1/admin/login",
    payload: { login, password: "nope-nope" },
  });
  assert.equal(wrong.statusCode, 401);

  const logged = await app.inject({
    method: "POST",
    url: "/api/v1/admin/login",
    payload: { login, password },
  });
  assert.equal(logged.statusCode, 200);
  const cookie = cookieFrom(logged.headers["set-cookie"]);
  assert.match(cookie, /^polosa_admin=/);

  const headers = { cookie };
  const createdService = await app.inject({
    method: "POST",
    url: "/api/v1/admin/services",
    headers,
    payload: {
      id: serviceId,
      name: "Проверка",
      description: "Временная услуга",
      durationMin: 30,
      price: 10000,
      sortOrder: 90,
    },
  });
  assert.equal(createdService.statusCode, 201, createdService.body);

  const createdBarber = await app.inject({
    method: "POST",
    url: "/api/v1/admin/barbers",
    headers,
    payload: {
      id: barberId,
      name: "Проверка Админ",
      photoUrl: "/barbers/aziz.jpg",
      bio: "Временный мастер",
      experienceYears: 1,
      sortOrder: 90,
      serviceIds: ["cut"],
    },
  });
  assert.equal(createdBarber.statusCode, 201, createdBarber.body);

  const schedule = await app.inject({
    method: "PUT",
    url: `/api/v1/admin/barbers/${barberId}/schedule`,
    headers,
    payload: {
      hours: [{ weekday: 2, start: "10:00", end: "18:00" }],
      breaks: [{ weekday: 2, start: "14:00", end: "15:00" }],
    },
  });
  assert.equal(schedule.statusCode, 200, schedule.body);
  const saved = schedule.json().barbers.find((item: { id: string }) => item.id === barberId);
  assert.equal(saved.breaks[0].start, "14:00");

  const off = await app.inject({
    method: "POST",
    url: "/api/v1/admin/time-off",
    headers,
    payload: {
      barberId,
      startsAt: "2026-11-02T05:00:00.000Z",
      endsAt: "2026-11-03T05:00:00.000Z",
      type: "day_off",
      note: "stage9",
    },
  });
  assert.equal(off.statusCode, 201, off.body);

  const slots = await app.inject({
    method: "GET",
    url: `/api/v1/admin/availability?serviceIds=cut&barberId=${barberId}&date=2026-10-20`,
    headers,
  });
  assert.equal(slots.statusCode, 200, slots.body);
  const startsAt = slots.json().slots[0]?.startsAt as string | undefined;
  assert.ok(startsAt);
  const booking = await app.inject({
    method: "POST",
    url: "/api/v1/admin/bookings",
    headers,
    payload: {
      serviceIds: ["cut"],
      barberId,
      startsAt,
      client: { name: "Админ Гость", phone },
    },
  });
  assert.equal(booking.statusCode, 201, booking.body);
  const bookingId = booking.json().booking.id as string;
  assert.equal(booking.json().booking.source, "admin");

  const moved = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/bookings/${bookingId}`,
    headers,
    payload: { startsAt: slots.json().slots[4].startsAt, status: "completed" },
  });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().booking.status, "completed");

  for (let attempt = 0; attempt < 9; attempt += 1) {
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/login",
      payload: { login, password: "nope-nope" },
    });
  }
  const limited = await app.inject({
    method: "POST",
    url: "/api/v1/admin/login",
    payload: { login, password },
  });
  assert.equal(limited.statusCode, 429);

  const removed = await app.inject({ method: "DELETE", url: `/api/v1/admin/services/${serviceId}`, headers });
  assert.equal(removed.statusCode, 200, removed.body);
});
