import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { buildApp } from "./routes.js";
import { resetLoginLimits } from "./adminAuth.js";
import { hashPassword } from "./password.js";
import { prisma } from "./prisma.js";
import { isoWeekday, zonedTimeToUtc } from "./slots.js";

const login = "stage10";
const password = "stage10-pass";
const serviceId = "stage10svc";
const barberId = "stage10bar";
const phones = ["+998901111001", "+998901111002"];
const zone = "Asia/Tashkent";

process.env.ADMIN_SESSION_SECRET = "stage10-session-secret-value";

function cookieFrom(header: string | string[] | undefined) {
  const line = Array.isArray(header) ? header[0] : header;
  assert.ok(line);
  return line.split(";")[0];
}

function at(date: string, clock: string) {
  return new Date(zonedTimeToUtc(date, clock, zone));
}

function clockDate(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return new Date(Date.UTC(1970, 0, 1, hours, minutes, 0));
}

async function visit(input: {
  phone: string;
  date: string;
  clock: string;
  minutes: number;
  price: number;
  status: "completed" | "cancelled" | "no_show";
}) {
  const client = await prisma.client.findUniqueOrThrow({ where: { phone: input.phone } });
  const [hour, minute] = input.clock.split(":").map(Number);
  const endHour = hour + Math.floor((minute + input.minutes) / 60);
  const endMinute = (minute + input.minutes) % 60;
  const end = `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`;
  await prisma.booking.create({
    data: {
      clientId: client.id,
      barberId,
      startsAt: at(input.date, input.clock),
      endsAt: at(input.date, end),
      totalPrice: input.price,
      totalDurationMin: input.minutes,
      status: input.status,
      source: "admin",
      manageToken: randomBytes(24).toString("hex"),
      services: {
        create: { serviceId, name: "Проверка", durationMin: input.minutes, price: input.price },
      },
    },
  });
}

async function cleanup() {
  await prisma.booking.deleteMany({ where: { OR: [{ barberId }, { client: { phone: { in: phones } } }] } });
  await prisma.client.deleteMany({ where: { phone: { in: phones } } });
  await prisma.barber.deleteMany({ where: { id: barberId } });
  await prisma.service.deleteMany({ where: { id: serviceId } });
  await prisma.adminUser.deleteMany({ where: { login } });
}

after(async () => {
  await cleanup();
  resetLoginLimits();
  await prisma.$disconnect();
});

test("аналитика считает выручку, услуги, загрузку, карту, отмены и возвращаемость", async () => {
  assert.equal(isoWeekday("2027-03-02"), 2);
  resetLoginLimits();
  await cleanup();
  const from = "2027-03-01";
  const to = "2027-03-07";
  const start = at(from, "00:00");
  const end = at("2027-03-08", "00:00");
  const strangers = await prisma.booking.count({ where: { startsAt: { gte: start, lt: end } } });
  assert.equal(strangers, 0);

  await prisma.service.create({
    data: { id: serviceId, name: "Проверка", description: "Временная", durationMin: 45, price: 80000, sortOrder: 90 },
  });
  await prisma.barber.create({
    data: {
      id: barberId,
      name: "Проверка",
      photoUrl: "/barbers/aziz.jpg",
      bio: "Временный",
      experienceYears: 1,
      sortOrder: 90,
      workingHours: { create: { id: `${barberId}-d2`, weekday: 2, startTime: clockDate("10:00"), endTime: clockDate("14:00") } },
      breaks: { create: { weekday: 2, startTime: clockDate("12:00"), endTime: clockDate("13:00") } },
    },
  });
  await prisma.client.createMany({
    data: [
      { name: "Постоянный", phone: phones[0] },
      { name: "Новый", phone: phones[1] },
    ],
  });
  await visit({ phone: phones[0], date: "2027-02-02", clock: "10:00", minutes: 45, price: 80000, status: "completed" });
  await visit({ phone: phones[0], date: "2027-03-02", clock: "10:00", minutes: 45, price: 80000, status: "completed" });
  await visit({ phone: phones[1], date: "2027-03-02", clock: "11:00", minutes: 30, price: 50000, status: "completed" });
  await visit({ phone: phones[1], date: "2027-03-03", clock: "10:00", minutes: 30, price: 50000, status: "cancelled" });
  await visit({ phone: phones[0], date: "2027-03-02", clock: "15:00", minutes: 30, price: 80000, status: "no_show" });

  await prisma.adminUser.create({ data: { login, passwordHash: await hashPassword(password) } });
  const app = buildApp();
  const closed = await app.inject({ method: "GET", url: `/api/v1/admin/analytics/revenue?from=${from}&to=${to}` });
  assert.equal(closed.statusCode, 401);

  const logged = await app.inject({ method: "POST", url: "/api/v1/admin/login", payload: { login, password } });
  assert.equal(logged.statusCode, 200);
  const headers = { cookie: cookieFrom(logged.headers["set-cookie"]) };
  const query = `from=${from}&to=${to}`;

  const revenue = await app.inject({ method: "GET", url: `/api/v1/admin/analytics/revenue?${query}`, headers });
  assert.equal(revenue.statusCode, 200);
  assert.deepEqual(revenue.json(), { from, to, revenue: 130000, completed: 2, bookings: 4 });

  const services = await app.inject({ method: "GET", url: `/api/v1/admin/analytics/services?${query}`, headers });
  assert.equal(services.statusCode, 200);
  assert.deepEqual(services.json().services, [{ id: serviceId, name: "Проверка", count: 4, revenue: 130000 }]);

  const load = await app.inject({ method: "GET", url: `/api/v1/admin/analytics/load?${query}`, headers });
  const barber = load.json().barbers.find((item: { id: string }) => item.id === barberId);
  assert.deepEqual(barber, {
    id: barberId,
    name: "Проверка",
    bookings: 2,
    minutes: 75,
    workMinutes: 180,
    occupancy: 42,
    revenue: 130000,
  });

  const heatmap = await app.inject({ method: "GET", url: `/api/v1/admin/analytics/heatmap?${query}`, headers });
  const cells = heatmap.json().cells as { weekday: number; hour: number; count: number }[];
  assert.deepEqual(
    cells.filter((cell) => cell.count > 0).sort((left, right) => left.hour - right.hour),
    [
      { weekday: 2, hour: 10, count: 1 },
      { weekday: 2, hour: 11, count: 1 },
    ],
  );

  const lost = await app.inject({ method: "GET", url: `/api/v1/admin/analytics/cancellations?${query}`, headers });
  const body = lost.json();
  assert.equal(body.cancelled, 1);
  assert.equal(body.noShow, 1);
  assert.equal(body.bookings, 4);
  assert.equal(body.cancelShare, 25);
  assert.equal(body.noShowShare, 25);
  assert.deepEqual(body.byBarber, [{ id: barberId, name: "Проверка", cancelled: 1, noShow: 1 }]);

  const retention = await app.inject({ method: "GET", url: `/api/v1/admin/analytics/retention?${query}`, headers });
  assert.deepEqual(retention.json(), { clients: 2, returning: 1, share: 50 });

  const backwards = await app.inject({ method: "GET", url: "/api/v1/admin/analytics/revenue?from=2027-03-07&to=2027-03-01", headers });
  assert.equal(backwards.statusCode, 400);
  await app.close();
});
