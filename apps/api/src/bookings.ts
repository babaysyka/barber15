import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ApiError } from "./errors.js";
import { notifyBookingChange, telegramStartUrl } from "./notify.js";
import { prisma } from "./prisma.js";
import { horizonDates, labelInZone, loadSettings, mergeSlots, offersFor, slotsByDate, slotsForOffers, type Offer, type Settings } from "./schedule.js";
import { canChangeAt, dateKeyInZone, type Slot } from "./slots.js";

export function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  const national =
    digits.length === 9 ? digits : digits.length === 12 && digits.startsWith("998") ? digits.slice(3) : null;
  if (!national || national.length !== 9) {
    return null;
  }
  return `+998${national}`;
}

export function isSlotTaken(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) && !(error instanceof Error)) {
    return false;
  }
  const known = error instanceof Prisma.PrismaClientKnownRequestError ? error : null;
  const blob = `${known?.code ?? ""} ${known?.message ?? ""} ${JSON.stringify(known?.meta ?? {})} ${error.message}`;
  return blob.includes("23P01") || blob.includes("bookings_no_overlap");
}

export async function requireOffers(serviceIds: string[], barberId: string): Promise<Offer[]> {
  if (barberId !== "any") {
    const barber = await prisma.barber.findFirst({ where: { id: barberId, isActive: true } });
    if (!barber) {
      throw new ApiError(404, "NOT_FOUND", "Барбер не найден");
    }
  }
  const offers = await offersFor(serviceIds, barberId);
  if (offers.length === 0) {
    const services = await prisma.service.count({ where: { id: { in: serviceIds }, isActive: true } });
    if (services !== new Set(serviceIds).size) {
      throw new ApiError(422, "SERVICE_NOT_FOUND", "Услуга не найдена");
    }
    throw new ApiError(422, "BARBER_CANNOT", "Мастер не делает выбранные услуги");
  }
  return offers;
}

export async function listDays(serviceIds: string[], barberId: string, now = Date.now()) {
  const settings = await loadSettings();
  const offers = await requireOffers(serviceIds, barberId);
  const dates = horizonDates(settings, now);
  const calendar = await slotsByDate(offers, dates, settings, now);
  const days = dates.map((date) => ({
    date,
    open: mergeSlots([...(calendar.get(date)?.values() ?? [])]).length > 0,
  }));
  return { timeZone: settings.timeZone, days };
}

export async function listSlots(
  serviceIds: string[],
  barberId: string,
  date: string,
  now = Date.now(),
  skipNotice = false,
) {
  const loaded = await loadSettings();
  const settings = skipNotice ? { ...loaded, minNoticeMin: 0 } : loaded;
  const offers = await requireOffers(serviceIds, barberId);
  const grouped = await slotsForOffers(offers, date, settings, now);
  return {
    date,
    durationMin: offers[0]?.durationMin ?? 0,
    slots: mergeSlots([...grouped.values()]),
  };
}

function slotMatches(slots: Slot[], startsAt: string): boolean {
  const target = new Date(startsAt).getTime();
  return slots.some((slot) => new Date(slot.startsAt).getTime() === target);
}

export async function pickOffer(offers: Offer[], startsAt: string, settings: Settings, ignoreBookingId?: string): Promise<Offer> {
  const date = dateKeyInZone(new Date(startsAt).getTime(), settings.timeZone);
  const grouped = await slotsForOffers(offers, date, settings, Date.now(), ignoreBookingId);
  const match = offers.find((offer) => slotMatches(grouped.get(offer.barberId) ?? [], startsAt));
  if (!match) {
    const open = await slotsForOffers(offers, date, settings, Date.now(), ignoreBookingId, true);
    if (offers.some((offer) => slotMatches(open.get(offer.barberId) ?? [], startsAt))) {
      throw new ApiError(409, "SLOT_TAKEN", "Это время уже заняли. Выберите другое.");
    }
    const today = dateKeyInZone(Date.now(), settings.timeZone);
    const [fromYear, fromMonth, fromDay] = today.split("-").map(Number);
    const [toYear, toMonth, toDay] = date.split("-").map(Number);
    const offset = Math.round(
      (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86_400_000,
    );
    if (offset > settings.horizonDays) {
      throw new ApiError(422, "TOO_FAR", "Эта дата ещё не открыта для записи");
    }
    if (new Date(startsAt).getTime() < Date.now() + settings.minNoticeMin * 60_000) {
      throw new ApiError(422, "TOO_SOON", "Слишком близко к текущему времени");
    }
    throw new ApiError(422, "OUTSIDE_WORKING_HOURS", "В это время мастер не работает");
  }
  return match;
}

function isUnique(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function saveClient(name: string, phone: string, telegramId?: string) {
  const byPhone = await prisma.client.findUnique({ where: { phone } });
  const byTelegram = telegramId ? await prisma.client.findUnique({ where: { telegramId } }) : null;
  if (byTelegram && byPhone && byTelegram.id !== byPhone.id) {
    throw new ApiError(409, "PHONE_TAKEN", "Этот телефон уже указан у другого гостя");
  }
  if (byPhone && telegramId && byPhone.telegramId && byPhone.telegramId !== telegramId) {
    throw new ApiError(409, "PHONE_TAKEN", "Этот телефон уже указан у другого гостя");
  }

  try {
    const telegramData = telegramId ? { telegramId, telegramChatId: byTelegram?.telegramChatId ?? telegramId } : {};
    if (byTelegram) {
      return await prisma.client.update({ where: { id: byTelegram.id }, data: { name, phone, ...telegramData } });
    }
    if (byPhone) {
      return await prisma.client.update({
        where: { id: byPhone.id },
        data: { name, ...telegramData },
      });
    }
    return await prisma.client.create({
      data: { name, phone, ...telegramData },
    });
  } catch (error) {
    if (!isUnique(error)) {
      throw error;
    }
    const again = await prisma.client.findUnique({ where: { phone } });
    if (!again) {
      throw new ApiError(409, "PHONE_TAKEN", "Этот телефон уже указан у другого гостя");
    }
    return again;
  }
}

export async function createBooking(input: {
  serviceIds: string[];
  barberId: string;
  startsAt: string;
  client: { name: string; phone: string };
  telegramId?: string;
  source?: "web" | "telegram" | "admin";
  skipNotice?: boolean;
}) {
  const phone = normalizePhone(input.client.phone);
  const name = input.client.name.trim();
  if (!phone || name.length < 2) {
    throw new ApiError(400, "VALIDATION", "Укажите имя и телефон");
  }
  const loaded = await loadSettings();
  const settings = input.skipNotice ? { ...loaded, minNoticeMin: 0 } : loaded;
  const offers = await requireOffers(input.serviceIds, input.barberId);
  const offer = await pickOffer(offers, input.startsAt, settings);
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(startsAt.getTime() + offer.durationMin * 60_000);
  const id = randomUUID();
  const manageToken = randomBytes(24).toString("hex");
  const client = await saveClient(name, phone, input.telegramId);

  try {
    await prisma.$transaction([
      prisma.booking.create({
        data: {
          id,
          client: { connect: { id: client.id } },
          barber: { connect: { id: offer.barberId } },
          startsAt,
          endsAt,
          totalPrice: offer.price,
          totalDurationMin: offer.durationMin,
          status: "confirmed",
          source: input.source ?? (input.telegramId ? "telegram" : "web"),
          manageToken,
        },
      }),
      prisma.bookingService.createMany({
        data: offer.services.map((service) => ({
          bookingId: id,
          serviceId: service.id,
          name: service.name,
          durationMin: service.durationMin,
          price: service.price,
        })),
      }),
    ]);
  } catch (error) {
    if (isSlotTaken(error)) {
      throw new ApiError(409, "SLOT_TAKEN", "Это время уже заняли. Выберите другое.");
    }
    throw error;
  }

  await notifyBookingChange(manageToken, "created");
  return readBooking(manageToken);
}

const bookingInclude = {
  barber: true,
  services: true,
  client: true,
} as const;

function toBookingView(
  booking: Awaited<ReturnType<typeof prisma.booking.findMany<{ include: typeof bookingInclude }>>>[number],
  settings: Settings,
) {
  return {
    status: booking.status,
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    date: dateKeyInZone(booking.startsAt.getTime(), settings.timeZone),
    time: labelInZone(booking.startsAt, settings),
    barber: { id: booking.barber.id, name: booking.barber.name },
    services: booking.services.map((service) => ({
      id: service.serviceId,
      name: service.name,
      durationMin: service.durationMin,
      price: service.price,
    })),
    totalPrice: booking.totalPrice,
    totalDurationMin: booking.totalDurationMin,
    clientName: booking.client.name,
    manageToken: booking.manageToken,
    telegramUrl: telegramStartUrl(booking.manageToken),
    canChange:
      booking.status === "confirmed" && canChangeAt(booking.startsAt.getTime(), Date.now(), settings.cancelCutoffMin),
  };
}

export async function readBooking(token: string) {
  const settings = await loadSettings();
  const booking = await prisma.booking.findUnique({
    where: { manageToken: token },
    include: bookingInclude,
  });
  if (!booking) {
    throw new ApiError(404, "NOT_FOUND", "Запись не найдена");
  }
  return { booking: toBookingView(booking, settings) };
}

export async function listMyBookings(telegramId: string) {
  const settings = await loadSettings();
  const client = await prisma.client.findUnique({ where: { telegramId } });
  if (!client) {
    return { bookings: [] };
  }
  const rows = await prisma.booking.findMany({
    where: { clientId: client.id },
    include: bookingInclude,
    orderBy: { startsAt: "desc" },
    take: 20,
  });
  return { bookings: rows.map((row) => toBookingView(row, settings)) };
}

async function requireChangeable(token: string) {
  const settings = await loadSettings();
  const booking = await prisma.booking.findUnique({
    where: { manageToken: token },
    include: { services: true },
  });
  if (!booking) {
    throw new ApiError(404, "NOT_FOUND", "Запись не найдена");
  }
  if (booking.status !== "confirmed") {
    throw new ApiError(422, "NOT_CONFIRMED", "Запись уже не активна");
  }
  if (!canChangeAt(booking.startsAt.getTime(), Date.now(), settings.cancelCutoffMin)) {
    throw new ApiError(422, "TOO_LATE", "Отменить или перенести уже нельзя");
  }
  return { booking, settings };
}

export async function cancelBooking(token: string) {
  const { booking } = await requireChangeable(token);
  await prisma.booking.update({ where: { id: booking.id }, data: { status: "cancelled" } });
  await notifyBookingChange(token, "cancelled");
  return readBooking(token);
}

export async function rescheduleBooking(token: string, startsAt: string) {
  const { booking, settings } = await requireChangeable(token);
  const serviceIds = booking.services.map((service) => service.serviceId);
  const offers = await requireOffers(serviceIds, booking.barberId);
  const offer = await pickOffer(offers, startsAt, settings, booking.id);
  const nextStart = new Date(startsAt);
  const nextEnd = new Date(nextStart.getTime() + offer.durationMin * 60_000);
  try {
    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        startsAt: nextStart,
        endsAt: nextEnd,
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
  await notifyBookingChange(token, "rescheduled");
  return readBooking(token);
}
