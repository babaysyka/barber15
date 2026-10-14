import { randomBytes } from "node:crypto";
import { Prisma, type BookingStatus, type TimeOffType } from "@prisma/client";
import { createBooking, isSlotTaken, listSlots, pickOffer, requireOffers } from "./bookings.js";
import { ApiError } from "./errors.js";
import { notifyBookingChange } from "./notify.js";
import { prisma } from "./prisma.js";
import { labelInZone, loadSettings } from "./schedule.js";
import { dateKeyInZone, zonedTimeToUtc } from "./slots.js";

const slug = /^[a-z0-9-]{2,32}$/;
const clock = /^([01]\d|2[0-3]):[0-5]\d$/;

const settingKeys = [
  "cancel_cutoff_min",
  "slot_step_min",
  "booking_horizon_days",
  "min_notice_min",
  "reminder_day_minutes",
  "reminder_short_minutes",
  "review_delay_min",
  "timezone",
  "review_public_min_rating",
] as const;

function clockDate(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return new Date(Date.UTC(1970, 0, 1, hours, minutes, 0));
}

function clockText(value: Date) {
  return `${value.getUTCHours().toString().padStart(2, "0")}:${value.getUTCMinutes().toString().padStart(2, "0")}`;
}

function nextDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

async function dayRange(date: string) {
  const settings = await loadSettings();
  return {
    settings,
    from: new Date(zonedTimeToUtc(date, "00:00", settings.timeZone)),
    to: new Date(zonedTimeToUtc(nextDate(date), "00:00", settings.timeZone)),
  };
}

const bookingInclude = {
  barber: true,
  services: true,
  client: true,
} as const;

function toAdminBooking(
  booking: Awaited<ReturnType<typeof prisma.booking.findMany<{ include: typeof bookingInclude }>>>[number],
  timeZone: string,
) {
  const settings = {
    timeZone,
    slotStepMin: 15,
    minNoticeMin: 0,
    horizonDays: 30,
    cancelCutoffMin: 0,
  };
  return {
    id: booking.id,
    status: booking.status,
    source: booking.source,
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    date: dateKeyInZone(booking.startsAt.getTime(), timeZone),
    time: labelInZone(booking.startsAt, settings),
    barber: { id: booking.barber.id, name: booking.barber.name },
    services: booking.services.map((service) => service.name),
    serviceIds: booking.services.map((service) => service.serviceId),
    totalPrice: booking.totalPrice,
    clientName: booking.client.name,
    clientPhone: booking.client.phone,
    manageToken: booking.manageToken,
  };
}

export async function adminBookings(date: string) {
  const { settings, from, to } = await dayRange(date);
  const rows = await prisma.booking.findMany({
    where: { startsAt: { gte: from, lt: to } },
    include: bookingInclude,
    orderBy: { startsAt: "asc" },
  });
  return { date, bookings: rows.map((row) => toAdminBooking(row, settings.timeZone)) };
}

export async function adminCreateBooking(input: {
  serviceIds: string[];
  barberId: string;
  startsAt: string;
  client: { name: string; phone: string };
}) {
  const created = await createBooking({ ...input, source: "admin", skipNotice: true });
  const row = await prisma.booking.findUnique({
    where: { manageToken: created.booking.manageToken },
    include: bookingInclude,
  });
  if (!row) {
    throw new ApiError(500, "INTERNAL", "Запись не сохранилась");
  }
  const settings = await loadSettings();
  return { booking: toAdminBooking(row, settings.timeZone) };
}

export async function adminPatchBooking(id: string, patch: { status?: BookingStatus; startsAt?: string }) {
  const booking = await prisma.booking.findUnique({ where: { id }, include: { services: true } });
  if (!booking) {
    throw new ApiError(404, "NOT_FOUND", "Запись не найдена");
  }
  if (patch.startsAt) {
    const loaded = await loadSettings();
    const settings = { ...loaded, minNoticeMin: 0 };
    const offers = await requireOffers(
      booking.services.map((service) => service.serviceId),
      booking.barberId,
    );
    const offer = await pickOffer(offers, patch.startsAt, settings, booking.id);
    const startsAt = new Date(patch.startsAt);
    try {
      await prisma.booking.update({
        where: { id },
        data: {
          startsAt,
          endsAt: new Date(startsAt.getTime() + offer.durationMin * 60_000),
          totalPrice: offer.price,
          totalDurationMin: offer.durationMin,
        },
      });
    } catch (error) {
      if (isSlotTaken(error)) {
        throw new ApiError(409, "SLOT_TAKEN", "Это время уже заняли. Выберите другое.");
      }
      throw error;
    }
    if ((patch.status ?? booking.status) === "confirmed") {
      await notifyBookingChange(booking.manageToken, "rescheduled");
    }
  }
  if (patch.status && patch.status !== booking.status) {
    try {
      await prisma.booking.update({ where: { id }, data: { status: patch.status } });
    } catch (error) {
      if (isSlotTaken(error)) {
        throw new ApiError(409, "SLOT_TAKEN", "Это время уже занято");
      }
      throw error;
    }
    if (patch.status === "cancelled") {
      await notifyBookingChange(booking.manageToken, "cancelled");
    }
  }
  const settings = await loadSettings();
  const next = await prisma.booking.findUnique({ where: { id }, include: bookingInclude });
  if (!next) {
    throw new ApiError(404, "NOT_FOUND", "Запись не найдена");
  }
  return { booking: toAdminBooking(next, settings.timeZone) };
}

export async function adminAvailability(serviceIds: string[], barberId: string, date: string) {
  return listSlots(serviceIds, barberId, date, Date.now(), true);
}

function toService(service: {
  id: string;
  name: string;
  description: string;
  durationMin: number;
  price: number;
  isActive: boolean;
  sortOrder: number;
}) {
  return service;
}

export async function listAdminServices() {
  const services = await prisma.service.findMany({ orderBy: { sortOrder: "asc" } });
  return { services: services.map(toService) };
}

export async function createService(input: {
  id: string;
  name: string;
  description: string;
  durationMin: number;
  price: number;
  sortOrder: number;
}) {
  if (!slug.test(input.id)) {
    throw new ApiError(400, "VALIDATION", "Код услуги: латиница, цифры и дефис");
  }
  try {
    const service = await prisma.service.create({ data: input });
    return { service: toService(service) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError(409, "EXISTS", "Такая услуга уже есть");
    }
    throw error;
  }
}

export async function patchService(
  id: string,
  input: Partial<{ name: string; description: string; durationMin: number; price: number; sortOrder: number; isActive: boolean }>,
) {
  try {
    const service = await prisma.service.update({ where: { id }, data: input });
    return { service: toService(service) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new ApiError(404, "NOT_FOUND", "Услуга не найдена");
    }
    throw error;
  }
}

export async function removeService(id: string) {
  const used = await prisma.bookingService.count({ where: { serviceId: id } });
  if (used > 0) {
    await prisma.service.update({ where: { id }, data: { isActive: false } });
    return { archived: true };
  }
  await prisma.service.delete({ where: { id } });
  return { archived: false };
}

const barberInclude = {
  services: true,
  portfolio: { orderBy: { sortOrder: "asc" as const } },
  workingHours: { orderBy: { weekday: "asc" as const } },
  breaks: { orderBy: { weekday: "asc" as const } },
} as const;

function toBarber(
  barber: Awaited<ReturnType<typeof prisma.barber.findMany<{ include: typeof barberInclude }>>>[number],
) {
  return {
    id: barber.id,
    name: barber.name,
    photoUrl: barber.photoUrl,
    bio: barber.bio,
    experienceYears: barber.experienceYears,
    isActive: barber.isActive,
    sortOrder: barber.sortOrder,
    serviceIds: barber.services.filter((item) => item.isEnabled).map((item) => item.serviceId),
    portfolio: barber.portfolio.map((item) => ({ id: item.id, imageUrl: item.imageUrl, sortOrder: item.sortOrder })),
    hours: barber.workingHours.map((item) => ({
      weekday: item.weekday,
      start: clockText(item.startTime),
      end: clockText(item.endTime),
    })),
    breaks: barber.breaks.map((item) => ({
      id: item.id,
      weekday: item.weekday,
      start: clockText(item.startTime),
      end: clockText(item.endTime),
    })),
  };
}

export async function listAdminBarbers() {
  const barbers = await prisma.barber.findMany({ orderBy: { sortOrder: "asc" }, include: barberInclude });
  return { barbers: barbers.map(toBarber) };
}

async function writeBarberServices(barberId: string, serviceIds: string[]) {
  const unique = [...new Set(serviceIds)];
  const found = await prisma.service.count({ where: { id: { in: unique } } });
  if (found !== unique.length) {
    throw new ApiError(422, "SERVICE_NOT_FOUND", "Услуга не найдена");
  }
  await prisma.barberService.deleteMany({ where: { barberId } });
  if (unique.length > 0) {
    await prisma.barberService.createMany({
      data: unique.map((serviceId) => ({ barberId, serviceId, isEnabled: true })),
    });
  }
}

export async function createBarber(input: {
  id: string;
  name: string;
  photoUrl: string;
  bio: string;
  experienceYears: number;
  sortOrder: number;
  serviceIds: string[];
}) {
  if (!slug.test(input.id)) {
    throw new ApiError(400, "VALIDATION", "Код барбера: латиница, цифры и дефис");
  }
  try {
    await prisma.barber.create({
      data: {
        id: input.id,
        name: input.name,
        photoUrl: input.photoUrl,
        bio: input.bio,
        experienceYears: input.experienceYears,
        sortOrder: input.sortOrder,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError(409, "EXISTS", "Такой барбер уже есть");
    }
    throw error;
  }
  await writeBarberServices(input.id, input.serviceIds);
  const barber = await prisma.barber.findUnique({ where: { id: input.id }, include: barberInclude });
  if (!barber) {
    throw new ApiError(500, "INTERNAL", "Барбер не сохранился");
  }
  return { barber: toBarber(barber) };
}

export async function patchBarber(
  id: string,
  input: Partial<{
    name: string;
    photoUrl: string;
    bio: string;
    experienceYears: number;
    sortOrder: number;
    isActive: boolean;
    serviceIds: string[];
  }>,
) {
  const { serviceIds, ...data } = input;
  try {
    await prisma.barber.update({ where: { id }, data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new ApiError(404, "NOT_FOUND", "Барбер не найден");
    }
    throw error;
  }
  if (serviceIds) {
    await writeBarberServices(id, serviceIds);
  }
  const barber = await prisma.barber.findUnique({ where: { id }, include: barberInclude });
  if (!barber) {
    throw new ApiError(404, "NOT_FOUND", "Барбер не найден");
  }
  return { barber: toBarber(barber) };
}

export async function removeBarber(id: string) {
  const used = await prisma.booking.count({ where: { barberId: id } });
  if (used > 0) {
    await prisma.barber.update({ where: { id }, data: { isActive: false } });
    return { archived: true };
  }
  await prisma.barber.delete({ where: { id } });
  return { archived: false };
}

export async function addPortfolio(barberId: string, imageUrl: string) {
  const barber = await prisma.barber.findUnique({ where: { id: barberId } });
  if (!barber) {
    throw new ApiError(404, "NOT_FOUND", "Барбер не найден");
  }
  const item = await prisma.portfolioItem.create({ data: { barberId, imageUrl } });
  return { item: { id: item.id, imageUrl: item.imageUrl, sortOrder: item.sortOrder } };
}

export async function removePortfolio(barberId: string, itemId: string) {
  const item = await prisma.portfolioItem.findFirst({ where: { id: itemId, barberId } });
  if (!item) {
    throw new ApiError(404, "NOT_FOUND", "Снимок не найден");
  }
  await prisma.portfolioItem.delete({ where: { id: itemId } });
  return { ok: true };
}

export async function saveSchedule(
  barberId: string,
  hours: { weekday: number; start: string; end: string }[],
  breaks: { weekday: number; start: string; end: string }[],
) {
  const barber = await prisma.barber.findUnique({ where: { id: barberId } });
  if (!barber) {
    throw new ApiError(404, "NOT_FOUND", "Барбер не найден");
  }
  const days = new Set<number>();
  for (const row of hours) {
    if (days.has(row.weekday) || !clock.test(row.start) || !clock.test(row.end) || row.start >= row.end) {
      throw new ApiError(400, "VALIDATION", "Проверьте часы работы");
    }
    days.add(row.weekday);
  }
  for (const row of breaks) {
    if (!days.has(row.weekday) || !clock.test(row.start) || !clock.test(row.end) || row.start >= row.end) {
      throw new ApiError(400, "VALIDATION", "Обед должен попадать в рабочий день");
    }
    const work = hours.find((item) => item.weekday === row.weekday);
    if (!work || row.start < work.start || row.end > work.end) {
      throw new ApiError(400, "VALIDATION", "Обед должен быть внутри смены");
    }
  }
  await prisma.$transaction([
    prisma.workingHours.deleteMany({ where: { barberId } }),
    prisma.break.deleteMany({ where: { barberId } }),
    prisma.workingHours.createMany({
      data: hours.map((row) => ({
        id: `${barberId}-d${row.weekday}`,
        barberId,
        weekday: row.weekday,
        startTime: clockDate(row.start),
        endTime: clockDate(row.end),
      })),
    }),
    prisma.break.createMany({
      data: breaks.map((row) => ({
        barberId,
        weekday: row.weekday,
        startTime: clockDate(row.start),
        endTime: clockDate(row.end),
      })),
    }),
  ]);
  return listAdminBarbers();
}

export async function listTimeOff() {
  const rows = await prisma.timeOff.findMany({
    orderBy: { startsAt: "asc" },
    include: { barber: { select: { id: true, name: true } } },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      barberId: row.barberId,
      barberName: row.barber?.name ?? "Весь салон",
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      type: row.type,
      note: row.note,
    })),
  };
}

export async function createTimeOff(input: {
  barberId: string | null;
  startsAt: string;
  endsAt: string;
  type: TimeOffType;
  note: string | null;
}) {
  if (new Date(input.endsAt) <= new Date(input.startsAt)) {
    throw new ApiError(400, "VALIDATION", "Конец исключения должен быть позже начала");
  }
  if (input.barberId) {
    const barber = await prisma.barber.findUnique({ where: { id: input.barberId } });
    if (!barber) {
      throw new ApiError(404, "NOT_FOUND", "Барбер не найден");
    }
  }
  const row = await prisma.timeOff.create({
    data: {
      barberId: input.barberId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      type: input.type,
      note: input.note,
    },
  });
  return { id: row.id };
}

export async function patchTimeOff(
  id: string,
  input: Partial<{ barberId: string | null; startsAt: string; endsAt: string; type: TimeOffType; note: string | null }>,
) {
  const current = await prisma.timeOff.findUnique({ where: { id } });
  if (!current) {
    throw new ApiError(404, "NOT_FOUND", "Исключение не найдено");
  }
  const startsAt = input.startsAt ? new Date(input.startsAt) : current.startsAt;
  const endsAt = input.endsAt ? new Date(input.endsAt) : current.endsAt;
  if (endsAt <= startsAt) {
    throw new ApiError(400, "VALIDATION", "Конец исключения должен быть позже начала");
  }
  await prisma.timeOff.update({
    where: { id },
    data: {
      barberId: input.barberId === undefined ? undefined : input.barberId,
      startsAt,
      endsAt,
      type: input.type,
      note: input.note === undefined ? undefined : input.note,
    },
  });
  return listTimeOff();
}

export async function removeTimeOff(id: string) {
  try {
    await prisma.timeOff.delete({ where: { id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new ApiError(404, "NOT_FOUND", "Исключение не найдено");
    }
    throw error;
  }
  return { ok: true };
}

export async function listSettings() {
  const rows = await prisma.setting.findMany();
  const settings = Object.fromEntries(settingKeys.map((key) => [key, rows.find((row) => row.key === key)?.value ?? ""]));
  return { settings };
}

export async function saveSettings(input: Record<string, string>) {
  for (const [key, value] of Object.entries(input)) {
    if (!settingKeys.includes(key as (typeof settingKeys)[number])) {
      throw new ApiError(400, "VALIDATION", "Неизвестная настройка");
    }
    if (key === "timezone") {
      if (!value.trim()) {
        throw new ApiError(400, "VALIDATION", "Укажите часовой пояс");
      }
    } else if (!/^\d+$/.test(value)) {
      throw new ApiError(400, "VALIDATION", "Настройка должна быть числом");
    }
    await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
  return listSettings();
}

export async function listReviews() {
  const rows = await prisma.review.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { client: true, barber: true },
  });
  return {
    reviews: rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      comment: row.comment,
      isPublic: row.isPublic,
      createdAt: row.createdAt.toISOString(),
      clientName: row.client.name,
      barberName: row.barber.name,
    })),
  };
}

export async function patchReview(id: string, isPublic: boolean) {
  try {
    await prisma.review.update({ where: { id }, data: { isPublic } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new ApiError(404, "NOT_FOUND", "Отзыв не найден");
    }
    throw error;
  }
  return listReviews();
}

let bucketReady = false;

function imageType(bytes: Buffer) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { type: "image/jpeg", ext: "jpg" };
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { type: "image/png", ext: "png" };
  }
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { type: "image/webp", ext: "webp" };
  }
  return null;
}

export async function uploadImage(dataBase64: string) {
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new ApiError(503, "STORAGE", "Хранилище фото не настроено");
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length < 32 || bytes.length > 2_000_000) {
    throw new ApiError(400, "VALIDATION", "Фото должно быть не больше 2 МБ");
  }
  const kind = imageType(bytes);
  if (!kind) {
    throw new ApiError(400, "VALIDATION", "Нужен файл JPEG, PNG или WebP");
  }
  const headers = { authorization: `Bearer ${key}`, apikey: key };
  if (!bucketReady) {
    const probe = await fetch(`${url}/storage/v1/bucket/media`, { headers });
    if (!probe.ok) {
      const created = await fetch(`${url}/storage/v1/bucket`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ id: "media", name: "media", public: true }),
      });
      if (!created.ok) {
        throw new ApiError(502, "STORAGE", "Не удалось открыть хранилище фото");
      }
    }
    bucketReady = true;
  }
  const path = `${Date.now()}-${randomBytes(4).toString("hex")}.${kind.ext}`;
  const saved = await fetch(`${url}/storage/v1/object/media/${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": kind.type },
    body: bytes,
  });
  if (!saved.ok) {
    throw new ApiError(502, "STORAGE", "Не удалось сохранить фото");
  }
  return { url: `${url}/storage/v1/object/public/media/${path}` };
}
