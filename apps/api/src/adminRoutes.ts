import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  cancellationsReport,
  heatmapReport,
  loadReport,
  readPeriod,
  retentionReport,
  revenueReport,
  servicesReport,
} from "./analytics.js";
import {
  addPortfolio,
  adminAvailability,
  adminBookings,
  adminCreateBooking,
  adminPatchBooking,
  createBarber,
  createService,
  createTimeOff,
  listAdminBarbers,
  listAdminServices,
  listReviews,
  listSettings,
  listTimeOff,
  patchBarber,
  patchReview,
  patchService,
  patchTimeOff,
  removeBarber,
  removePortfolio,
  removeService,
  removeTimeOff,
  saveSchedule,
  saveSettings,
  uploadImage,
} from "./admin.js";
import {
  adminFromCookie,
  assertLoginAllowed,
  clearSessionCookie,
  noteLoginFailure,
  noteLoginSuccess,
  sessionCookie,
  signSession,
} from "./adminAuth.js";
import { ApiError } from "./errors.js";
import { verifyPassword } from "./password.js";
import { prisma } from "./prisma.js";

const slug = z.string().regex(/^[a-z0-9-]{2,32}$/);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const statusField = z.enum(["confirmed", "completed", "cancelled", "no_show"]);
const timeOffType = z.enum(["day_off", "vacation", "sick", "closure"]);

function cookieOf(request: FastifyRequest) {
  const value = request.headers.cookie;
  return Array.isArray(value) ? value.join("; ") : value;
}

async function periodOf(request: FastifyRequest) {
  await guard(request);
  const query = z.object({ from: dateField, to: dateField }).parse(request.query);
  return readPeriod(query.from, query.to);
}

async function guard(request: FastifyRequest) {
  const admin = await adminFromCookie(cookieOf(request));
  if (!admin) {
    throw new ApiError(401, "ADMIN_AUTH", "Войдите в админку");
  }
  return admin;
}

export function registerAdmin(app: FastifyInstance) {
  app.post("/api/v1/admin/login", async (request, reply) => {
    const body = z.object({ login: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) }).parse(request.body);
    assertLoginAllowed(request.ip);
    const admin = await prisma.adminUser.findUnique({ where: { login: body.login } });
    const matches = admin ? await verifyPassword(body.password, admin.passwordHash) : false;
    if (!admin || !matches) {
      noteLoginFailure(request.ip);
      throw new ApiError(401, "ADMIN_AUTH", "Неверный логин или пароль");
    }
    noteLoginSuccess(request.ip);
    reply.header("set-cookie", sessionCookie(signSession(admin.id)));
    return { login: admin.login };
  });

  app.post("/api/v1/admin/logout", async (_request, reply) => {
    reply.header("set-cookie", clearSessionCookie());
    return { ok: true };
  });

  app.get("/api/v1/admin/session", async (request) => {
    const admin = await guard(request);
    return { login: admin.login };
  });

  app.get("/api/v1/admin/bookings", async (request) => {
    await guard(request);
    const query = z.object({ date: dateField }).parse(request.query);
    return adminBookings(query.date);
  });

  app.post("/api/v1/admin/bookings", async (request, reply) => {
    await guard(request);
    const body = z
      .object({
        serviceIds: z.array(z.string().trim().min(1).max(64)).min(1).max(6),
        barberId: z.string().trim().min(1).max(64),
        startsAt: z.string().datetime(),
        client: z.object({
          name: z.string().trim().min(2).max(80),
          phone: z.string().trim().min(9).max(20),
        }),
      })
      .parse(request.body);
    const created = await adminCreateBooking(body);
    return reply.status(201).send(created);
  });

  app.patch("/api/v1/admin/bookings/:id", async (request) => {
    await guard(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ status: statusField.optional(), startsAt: z.string().datetime().optional() })
      .refine((value) => value.status !== undefined || value.startsAt !== undefined)
      .parse(request.body);
    return adminPatchBooking(params.id, body);
  });

  app.get("/api/v1/admin/availability", async (request) => {
    await guard(request);
    const query = z
      .object({
        serviceIds: z.string().trim().min(1),
        barberId: z.string().trim().min(1).max(64),
        date: dateField,
      })
      .parse(request.query);
    return adminAvailability(query.serviceIds.split(",").filter(Boolean), query.barberId, query.date);
  });

  app.get("/api/v1/admin/services", async (request) => {
    await guard(request);
    return listAdminServices();
  });

  app.post("/api/v1/admin/services", async (request, reply) => {
    await guard(request);
    const body = z
      .object({
        id: slug,
        name: z.string().trim().min(2).max(80),
        description: z.string().trim().max(400),
        durationMin: z.number().int().min(10).max(240),
        price: z.number().int().min(0).max(10_000_000),
        sortOrder: z.number().int().min(0).max(100),
      })
      .parse(request.body);
    return reply.status(201).send(await createService(body));
  });

  app.patch("/api/v1/admin/services/:id", async (request) => {
    await guard(request);
    const params = z.object({ id: slug }).parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(2).max(80).optional(),
        description: z.string().trim().max(400).optional(),
        durationMin: z.number().int().min(10).max(240).optional(),
        price: z.number().int().min(0).max(10_000_000).optional(),
        sortOrder: z.number().int().min(0).max(100).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(request.body);
    return patchService(params.id, body);
  });

  app.delete("/api/v1/admin/services/:id", async (request) => {
    await guard(request);
    const params = z.object({ id: slug }).parse(request.params);
    return removeService(params.id);
  });

  app.get("/api/v1/admin/barbers", async (request) => {
    await guard(request);
    return listAdminBarbers();
  });

  app.post("/api/v1/admin/barbers", async (request, reply) => {
    await guard(request);
    const body = z
      .object({
        id: slug,
        name: z.string().trim().min(2).max(80),
        photoUrl: z.string().trim().min(1).max(500),
        bio: z.string().trim().max(600),
        experienceYears: z.number().int().min(0).max(60),
        sortOrder: z.number().int().min(0).max(100),
        serviceIds: z.array(slug).max(12),
      })
      .parse(request.body);
    return reply.status(201).send(await createBarber(body));
  });

  app.patch("/api/v1/admin/barbers/:id", async (request) => {
    await guard(request);
    const params = z.object({ id: slug }).parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(2).max(80).optional(),
        photoUrl: z.string().trim().min(1).max(500).optional(),
        bio: z.string().trim().max(600).optional(),
        experienceYears: z.number().int().min(0).max(60).optional(),
        sortOrder: z.number().int().min(0).max(100).optional(),
        isActive: z.boolean().optional(),
        serviceIds: z.array(slug).max(12).optional(),
      })
      .parse(request.body);
    return patchBarber(params.id, body);
  });

  app.delete("/api/v1/admin/barbers/:id", async (request) => {
    await guard(request);
    const params = z.object({ id: slug }).parse(request.params);
    return removeBarber(params.id);
  });

  app.put("/api/v1/admin/barbers/:id/schedule", async (request) => {
    await guard(request);
    const params = z.object({ id: slug }).parse(request.params);
    const body = z
      .object({
        hours: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: clock, end: clock })).max(7),
        breaks: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: clock, end: clock })).max(14),
      })
      .parse(request.body);
    return saveSchedule(params.id, body.hours, body.breaks);
  });

  app.post("/api/v1/admin/barbers/:id/portfolio", async (request, reply) => {
    await guard(request);
    const params = z.object({ id: slug }).parse(request.params);
    const body = z.object({ imageUrl: z.string().trim().min(1).max(500) }).parse(request.body);
    return reply.status(201).send(await addPortfolio(params.id, body.imageUrl));
  });

  app.delete("/api/v1/admin/barbers/:id/portfolio/:itemId", async (request) => {
    await guard(request);
    const params = z.object({ id: slug, itemId: z.string().uuid() }).parse(request.params);
    return removePortfolio(params.id, params.itemId);
  });

  app.get("/api/v1/admin/time-off", async (request) => {
    await guard(request);
    return listTimeOff();
  });

  app.post("/api/v1/admin/time-off", async (request, reply) => {
    await guard(request);
    const body = z
      .object({
        barberId: z.string().trim().min(1).max(64).nullable(),
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        type: timeOffType,
        note: z.string().trim().max(200).nullable(),
      })
      .parse(request.body);
    return reply.status(201).send(await createTimeOff(body));
  });

  app.patch("/api/v1/admin/time-off/:id", async (request) => {
    await guard(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        barberId: z.string().trim().min(1).max(64).nullable().optional(),
        startsAt: z.string().datetime().optional(),
        endsAt: z.string().datetime().optional(),
        type: timeOffType.optional(),
        note: z.string().trim().max(200).nullable().optional(),
      })
      .parse(request.body);
    return patchTimeOff(params.id, body);
  });

  app.delete("/api/v1/admin/time-off/:id", async (request) => {
    await guard(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return removeTimeOff(params.id);
  });

  app.get("/api/v1/admin/reviews", async (request) => {
    await guard(request);
    return listReviews();
  });

  app.patch("/api/v1/admin/reviews/:id", async (request) => {
    await guard(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ isPublic: z.boolean() }).parse(request.body);
    return patchReview(params.id, body.isPublic);
  });

  app.get("/api/v1/admin/settings", async (request) => {
    await guard(request);
    return listSettings();
  });

  app.put("/api/v1/admin/settings", async (request) => {
    await guard(request);
    const body = z.record(z.string().max(64), z.string().max(80)).parse(request.body);
    return saveSettings(body);
  });

  app.get("/api/v1/admin/analytics/revenue", async (request) => revenueReport(await periodOf(request)));
  app.get("/api/v1/admin/analytics/services", async (request) => servicesReport(await periodOf(request)));
  app.get("/api/v1/admin/analytics/load", async (request) => loadReport(await periodOf(request)));
  app.get("/api/v1/admin/analytics/heatmap", async (request) => heatmapReport(await periodOf(request)));
  app.get("/api/v1/admin/analytics/cancellations", async (request) => cancellationsReport(await periodOf(request)));
  app.get("/api/v1/admin/analytics/retention", async (request) => retentionReport(await periodOf(request)));

  app.post("/api/v1/admin/uploads", async (request) => {
    await guard(request);
    const body = z.object({ dataBase64: z.string().min(32).max(3_000_000) }).parse(request.body);
    return uploadImage(body.dataBase64);
  });
}
