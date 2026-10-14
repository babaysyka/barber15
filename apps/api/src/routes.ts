import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Update } from "@grammyjs/types";
import { ZodError, z } from "zod";
import { getBot } from "./bot.js";
import { cancelBooking, createBooking, listDays, listMyBookings, listSlots, readBooking, rescheduleBooking } from "./bookings.js";
import { ApiError } from "./errors.js";
import { registerAdmin } from "./adminRoutes.js";
import { prisma } from "./prisma.js";
import { runReminders } from "./reminders.js";
import { verifyInitData } from "./telegram.js";

const serviceSelect = {
  id: true,
  name: true,
  description: true,
  durationMin: true,
  price: true,
} as const;

const barberArgs = {
  where: { isActive: true },
  orderBy: { sortOrder: "asc" as const },
  include: {
    services: {
      where: { isEnabled: true, service: { isActive: true } },
      include: { service: { select: { id: true, name: true, sortOrder: true } } },
    },
  },
};

type BarberRow = Awaited<ReturnType<typeof prisma.barber.findMany<typeof barberArgs>>>[number];

function toBarber(barber: BarberRow) {
  const services = [...barber.services].sort((left, right) => left.service.sortOrder - right.service.sortOrder);
  return {
    id: barber.id,
    name: barber.name,
    photoUrl: barber.photoUrl,
    bio: barber.bio,
    experienceYears: barber.experienceYears,
    services: services.map((item) => item.service.name),
  };
}

const idParams = z.object({
  id: z.string().trim().min(1).max(64),
});

export function buildApp() {
  const app = Fastify({ logger: !process.env.NODE_TEST_CONTEXT, bodyLimit: 4 * 1024 * 1024 });
  registerRoutes(app);
  return app;
}

export function registerRoutes(app: FastifyInstance) {
  const origins = [
    ...new Set(
      [
          ...(process.env.CORS_ORIGIN ?? "http://localhost:3000").split(","),
          "http://localhost:3000",
          "http://localhost:3010",
          "http://localhost:5173",
        ]
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];

  app.register(cors, {
    origin: origins,
    allowedHeaders: ["content-type", "x-telegram-init-data"],
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ code: "VALIDATION", message: "Некорректный запрос" });
    }
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message });
    }
    request.log.error(error);
    return reply.status(500).send({ code: "INTERNAL", message: "Внутренняя ошибка" });
  });

  app.post("/telegram/webhook", async (request, reply) => {
    const current = getBot();
    if (!current) {
      throw new ApiError(503, "TELEGRAM_NOT_CONFIGURED", "В .env не задан TELEGRAM_BOT_TOKEN");
    }
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    const header = request.headers["x-telegram-bot-api-secret-token"];
    if (secret) {
      const given = typeof header === "string" ? header : "";
      const left = Buffer.from(given);
      const right = Buffer.from(secret);
      if (left.length !== right.length || !timingSafeEqual(left, right)) {
        throw new ApiError(401, "TELEGRAM_AUTH", "Неверный секрет webhook");
      }
    }
    const update = z.object({ update_id: z.number().int() }).passthrough().parse(request.body);
    await current.handleUpdate(update as Update);
    return reply.status(200).send({ ok: true });
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/internal/notifications", async (request) => {
    const secret = process.env.CRON_SECRET ?? "";
    if (!secret) {
      throw new ApiError(503, "CRON_NOT_CONFIGURED", "В .env не задан CRON_SECRET");
    }
    const header = request.headers["x-cron-secret"];
    const given = typeof header === "string" ? header : "";
    const left = Buffer.from(given);
    const right = Buffer.from(secret);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new ApiError(401, "CRON_AUTH", "Неверный секрет cron");
    }
    return runReminders();
  });

  registerAdmin(app);

  app.get("/api/v1/services", async () => {
    const services = await prisma.service.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: serviceSelect,
    });
    return { services };
  });

  app.get("/api/v1/barbers", async () => {
    const barbers = await prisma.barber.findMany(barberArgs);
    return { barbers: barbers.map(toBarber) };
  });

  app.get("/api/v1/barbers/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const barber = await prisma.barber.findFirst({
      ...barberArgs,
      where: { id, isActive: true },
    });
    if (!barber) {
      throw new ApiError(404, "NOT_FOUND", "Барбер не найден");
    }
    return { barber: toBarber(barber) };
  });

  const serviceIdsField = z.string().trim().min(1).max(400);
  const barberField = z.string().trim().min(1).max(64);
  const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const tokenParams = z.object({
    token: z.string().trim().regex(/^[a-f0-9]{32,80}$/),
  });

  function serviceIdsOf(value: string): string[] {
    const ids = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > 6 || ids.some((id) => id.length > 64)) {
      throw new ApiError(400, "VALIDATION", "Некорректный запрос");
    }
    return ids;
  }

  app.get("/api/v1/availability/days", async (request) => {
    const query = z
      .object({
        serviceIds: serviceIdsField,
        barberId: barberField,
      })
      .parse(request.query);
    return listDays(serviceIdsOf(query.serviceIds), query.barberId);
  });

  app.get("/api/v1/availability", async (request) => {
    const query = z
      .object({
        serviceIds: serviceIdsField,
        barberId: barberField,
        date: dateField,
      })
      .parse(request.query);
    return listSlots(serviceIdsOf(query.serviceIds), query.barberId, query.date);
  });

  function telegramOf(request: { headers: Record<string, unknown> }) {
    const raw = request.headers["x-telegram-init-data"];
    if (raw === undefined) {
      return null;
    }
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) {
      throw new ApiError(401, "TELEGRAM_AUTH", "Не удалось подтвердить Telegram");
    }
    return verifyInitData(raw, process.env.TELEGRAM_BOT_TOKEN ?? "");
  }

  app.post("/api/v1/telegram/auth", async (request) => {
    const body = z.object({ initData: z.string().min(1).max(4096) }).parse(request.body);
    const user = verifyInitData(body.initData, process.env.TELEGRAM_BOT_TOKEN ?? "");
    const client = await prisma.client.findUnique({
      where: { telegramId: user.id },
      select: { name: true, phone: true },
    });
    return {
      user: { id: user.id, firstName: user.firstName, lastName: user.lastName },
      client,
    };
  });

  app.get("/api/v1/me/bookings", async (request) => {
    const user = telegramOf(request);
    if (!user) {
      throw new ApiError(401, "TELEGRAM_AUTH", "Откройте запись из Telegram");
    }
    return listMyBookings(user.id);
  });

  app.post("/api/v1/bookings", async (request, reply) => {
    const body = z
      .object({
        serviceIds: z.array(z.string().trim().min(1).max(64)).min(1).max(6),
        barberId: barberField,
        startsAt: z.string().datetime(),
        client: z.object({
          name: z.string().trim().min(2).max(80),
          phone: z.string().trim().min(9).max(20),
        }),
      })
      .parse(request.body);
    const telegram = telegramOf(request);
    const created = await createBooking({ ...body, telegramId: telegram?.id });
    return reply.status(201).send(created);
  });

  app.get("/api/v1/bookings/:token", async (request) => {
    const { token } = tokenParams.parse(request.params);
    return readBooking(token);
  });

  app.post("/api/v1/bookings/:token/cancel", async (request) => {
    const { token } = tokenParams.parse(request.params);
    return cancelBooking(token);
  });

  app.post("/api/v1/bookings/:token/reschedule", async (request) => {
    const { token } = tokenParams.parse(request.params);
    const body = z.object({ startsAt: z.string().datetime() }).parse(request.body);
    return rescheduleBooking(token, body.startsAt);
  });
}
