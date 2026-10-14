import { prisma } from "./prisma.js";
import { clockLabel, computeSlots, dateKeyInZone, isoWeekday, zonedTimeToUtc, type Range, type Slot } from "./slots.js";

export type Settings = {
  timeZone: string;
  slotStepMin: number;
  minNoticeMin: number;
  horizonDays: number;
  cancelCutoffMin: number;
};

export type Offer = {
  barberId: string;
  durationMin: number;
  price: number;
  services: { id: string; name: string; durationMin: number; price: number }[];
};

const defaults: Settings = {
  timeZone: "Asia/Tashkent",
  slotStepMin: 15,
  minNoticeMin: 30,
  horizonDays: 30,
  cancelCutoffMin: 30,
};

function numberSetting(map: Map<string, string>, key: string, fallback: number): number {
  const value = Number(map.get(key));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function loadSettings(): Promise<Settings> {
  const rows = await prisma.setting.findMany();
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    timeZone: map.get("timezone") || defaults.timeZone,
    slotStepMin: numberSetting(map, "slot_step_min", defaults.slotStepMin) || defaults.slotStepMin,
    minNoticeMin: numberSetting(map, "min_notice_min", defaults.minNoticeMin),
    horizonDays: numberSetting(map, "booking_horizon_days", defaults.horizonDays),
    cancelCutoffMin: numberSetting(map, "cancel_cutoff_min", defaults.cancelCutoffMin),
  };
}

function clockOf(value: Date): string {
  const hours = value.getUTCHours().toString().padStart(2, "0");
  const minutes = value.getUTCMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

export async function offersFor(serviceIds: string[], barberId: string): Promise<Offer[]> {
  const uniqueIds = [...new Set(serviceIds)];
  const services = await prisma.service.findMany({
    where: { id: { in: uniqueIds }, isActive: true },
  });
  if (services.length !== uniqueIds.length) {
    return [];
  }

  const barbers = await prisma.barber.findMany({
    where: {
      isActive: true,
      ...(barberId === "any" ? {} : { id: barberId }),
      AND: uniqueIds.map((serviceId) => ({
        services: { some: { serviceId, isEnabled: true } },
      })),
    },
    orderBy: { sortOrder: "asc" },
    include: {
      services: {
        where: { serviceId: { in: uniqueIds }, isEnabled: true },
        include: { service: true },
      },
    },
  });

  return barbers.map((barber) => {
    const lines = uniqueIds.map((serviceId) => {
      const link = barber.services.find((item) => item.serviceId === serviceId);
      if (!link) {
        throw new Error("service link missing");
      }
      return {
        id: link.service.id,
        name: link.service.name,
        durationMin: link.durationMin ?? link.service.durationMin,
        price: link.price ?? link.service.price,
      };
    });
    return {
      barberId: barber.id,
      durationMin: lines.reduce((sum, line) => sum + line.durationMin, 0),
      price: lines.reduce((sum, line) => sum + line.price, 0),
      services: lines,
    };
  });
}

function nextDateKey(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

export async function slotsByDate(
  offerList: Offer[],
  dates: string[],
  settings: Settings,
  now = Date.now(),
  ignoreBookingId?: string,
  skipBookings = false,
): Promise<Map<string, Map<string, Slot[]>>> {
  const result = new Map<string, Map<string, Slot[]>>();
  if (offerList.length === 0 || dates.length === 0) {
    return result;
  }

  const barberIds = offerList.map((offer) => offer.barberId);
  const weekdays = [...new Set(dates.map(isoWeekday))];
  const rangeStart = zonedTimeToUtc(dates[0] ?? "", "00:00", settings.timeZone);
  const rangeEnd = zonedTimeToUtc(nextDateKey(dates[dates.length - 1] ?? ""), "00:00", settings.timeZone);

  const [hours, breaks, timeOff, bookings] = await Promise.all([
    prisma.workingHours.findMany({ where: { barberId: { in: barberIds }, weekday: { in: weekdays } } }),
    prisma.break.findMany({ where: { barberId: { in: barberIds }, weekday: { in: weekdays } } }),
    prisma.timeOff.findMany({
      where: {
        OR: [{ barberId: null }, { barberId: { in: barberIds } }],
        startsAt: { lt: new Date(rangeEnd) },
        endsAt: { gt: new Date(rangeStart) },
      },
    }),
    skipBookings
      ? Promise.resolve([])
      : prisma.booking.findMany({
          where: {
            barberId: { in: barberIds },
            status: "confirmed",
            id: ignoreBookingId ? { not: ignoreBookingId } : undefined,
            startsAt: { lt: new Date(rangeEnd) },
            endsAt: { gt: new Date(rangeStart) },
          },
        }),
  ]);

  for (const date of dates) {
    const weekday = isoWeekday(date);
    const dayStart = zonedTimeToUtc(date, "00:00", settings.timeZone);
    const dayEnd = zonedTimeToUtc(nextDateKey(date), "00:00", settings.timeZone);
    const byBarber = new Map<string, Slot[]>();
    for (const offer of offerList) {
      const work = hours.find((item) => item.barberId === offer.barberId && item.weekday === weekday);
      const blocked: Range[] = [
        ...timeOff
          .filter(
            (item) =>
              (item.barberId === null || item.barberId === offer.barberId) &&
              item.startsAt.getTime() < dayEnd &&
              item.endsAt.getTime() > dayStart,
          )
          .map((item) => ({ start: item.startsAt.getTime(), end: item.endsAt.getTime() })),
        ...bookings
          .filter(
            (item) =>
              item.barberId === offer.barberId &&
              item.startsAt.getTime() < dayEnd &&
              item.endsAt.getTime() > dayStart,
          )
          .map((item) => ({ start: item.startsAt.getTime(), end: item.endsAt.getTime() })),
      ];
      byBarber.set(
        offer.barberId,
        computeSlots({
          now,
          date,
          timeZone: settings.timeZone,
          durationMin: offer.durationMin,
          slotStepMin: settings.slotStepMin,
          minNoticeMin: settings.minNoticeMin,
          horizonDays: settings.horizonDays,
          work: work ? { start: clockOf(work.startTime), end: clockOf(work.endTime) } : null,
          breaks: breaks
            .filter((item) => item.barberId === offer.barberId && item.weekday === weekday)
            .map((item) => ({ start: clockOf(item.startTime), end: clockOf(item.endTime) })),
          blocked,
        }),
      );
    }
    result.set(date, byBarber);
  }
  return result;
}

export async function slotsForOffers(
  offerList: Offer[],
  date: string,
  settings: Settings,
  now = Date.now(),
  ignoreBookingId?: string,
  skipBookings = false,
): Promise<Map<string, Slot[]>> {
  const calendar = await slotsByDate(offerList, [date], settings, now, ignoreBookingId, skipBookings);
  return calendar.get(date) ?? new Map();
}

export function mergeSlots(groups: Slot[][]): Slot[] {
  const byStart = new Map<string, Slot>();
  for (const group of groups) {
    for (const slot of group) {
      if (!byStart.has(slot.startsAt)) {
        byStart.set(slot.startsAt, slot);
      }
    }
  }
  return [...byStart.values()].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

export function horizonDates(settings: Settings, now = Date.now()): string[] {
  const today = dateKeyInZone(now, settings.timeZone);
  const [year, month, day] = today.split("-").map(Number);
  const dates: string[] = [];
  for (let offset = 0; offset <= settings.horizonDays; offset += 1) {
    const next = new Date(Date.UTC(year, month - 1, day + offset));
    const key = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
    dates.push(key);
  }
  return dates;
}

export function labelInZone(instant: Date, settings: Settings): string {
  return clockLabel(instant.getTime(), settings.timeZone);
}
