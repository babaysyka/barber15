import { ApiError } from "./errors.js";
import { prisma } from "./prisma.js";
import { loadSettings } from "./schedule.js";
import { clockLabel, dateKeyInZone, dayOffset, isoWeekday, zonedTimeToUtc } from "./slots.js";

export type Period = {
  from: string;
  to: string;
  start: Date;
  end: Date;
  timeZone: string;
};

type Visit = {
  status: "confirmed" | "completed" | "cancelled" | "no_show";
  totalPrice: number;
  totalDurationMin: number;
  barberId: string;
  clientId: string;
  startsAt: Date;
  services: { serviceId: string; name: string; price: number }[];
};

const occupied = new Set(["confirmed", "completed"]);

function nextDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function eachDate(from: string, to: string) {
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to && dates.length <= 366) {
    dates.push(cursor);
    cursor = nextDate(cursor);
  }
  return dates;
}

function clockMinutes(clock: string) {
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}

function localMinutes(instant: Date, timeZone: string) {
  const [hour, minute] = clockLabel(instant.getTime(), timeZone).split(":").map(Number);
  return hour * 60 + minute;
}

function share(part: number, total: number) {
  return total === 0 ? 0 : Math.round((part * 100) / total);
}

function cut(free: { start: number; end: number }[], block: { start: number; end: number }) {
  const next: { start: number; end: number }[] = [];
  for (const item of free) {
    if (block.end <= item.start || block.start >= item.end) {
      next.push(item);
      continue;
    }
    if (block.start > item.start) {
      next.push({ start: item.start, end: Math.min(block.start, item.end) });
    }
    if (block.end < item.end) {
      next.push({ start: Math.max(block.end, item.start), end: item.end });
    }
  }
  return next.filter((item) => item.end > item.start);
}

export async function readPeriod(from: string, to: string): Promise<Period> {
  const settings = await loadSettings();
  if (from > to) {
    throw new ApiError(400, "VALIDATION", "Начало периода позже конца");
  }
  if (dayOffset(from, to) > 366) {
    throw new ApiError(400, "VALIDATION", "Период не длиннее года");
  }
  return {
    from,
    to,
    start: new Date(zonedTimeToUtc(from, "00:00", settings.timeZone)),
    end: new Date(zonedTimeToUtc(nextDate(to), "00:00", settings.timeZone)),
    timeZone: settings.timeZone,
  };
}

async function visits(period: Period): Promise<Visit[]> {
  return prisma.booking.findMany({
    where: { startsAt: { gte: period.start, lt: period.end } },
    select: {
      status: true,
      totalPrice: true,
      totalDurationMin: true,
      barberId: true,
      clientId: true,
      startsAt: true,
      services: { select: { serviceId: true, name: true, price: true } },
    },
  });
}

export async function revenueReport(period: Period) {
  const rows = await visits(period);
  const completed = rows.filter((row) => row.status === "completed");
  return {
    from: period.from,
    to: period.to,
    revenue: completed.reduce((sum, row) => sum + row.totalPrice, 0),
    completed: completed.length,
    bookings: rows.length,
  };
}

export async function servicesReport(period: Period) {
  const rows = await visits(period);
  const map = new Map<string, { id: string; name: string; count: number; revenue: number }>();
  for (const row of rows) {
    for (const line of row.services) {
      const item = map.get(line.serviceId) ?? { id: line.serviceId, name: line.name, count: 0, revenue: 0 };
      item.count += 1;
      item.name = line.name;
      if (row.status === "completed") {
        item.revenue += line.price;
      }
      map.set(line.serviceId, item);
    }
  }
  return {
    services: [...map.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "ru")),
  };
}

export async function loadReport(period: Period) {
  const [rows, barbers, offs] = await Promise.all([
    visits(period),
    prisma.barber.findMany({
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        workingHours: { select: { weekday: true, startTime: true, endTime: true } },
        breaks: { select: { weekday: true, startTime: true, endTime: true } },
      },
    }),
    prisma.timeOff.findMany({
      where: { startsAt: { lt: period.end }, endsAt: { gt: period.start } },
      select: { barberId: true, startsAt: true, endsAt: true },
    }),
  ]);
  const dates = eachDate(period.from, period.to);

  return {
    barbers: barbers.map((barber) => {
      const own = rows.filter((row) => row.barberId === barber.id);
      const busy = own.filter((row) => occupied.has(row.status));
      let workMinutes = 0;
      for (const date of dates) {
        const weekday = isoWeekday(date);
        const shift = barber.workingHours.find((item) => item.weekday === weekday);
        if (!shift) {
          continue;
        }
        const shiftStart = clockMinutes(clockText(shift.startTime));
        const shiftEnd = clockMinutes(clockText(shift.endTime));
        let free = [{ start: shiftStart, end: shiftEnd }];
        for (const item of barber.breaks.filter((entry) => entry.weekday === weekday)) {
          free = cut(free, { start: clockMinutes(clockText(item.startTime)), end: clockMinutes(clockText(item.endTime)) });
        }
        const dayStart = zonedTimeToUtc(date, "00:00", period.timeZone);
        const dayEnd = zonedTimeToUtc(nextDate(date), "00:00", period.timeZone);
        for (const off of offs) {
          if (off.barberId !== null && off.barberId !== barber.id) {
            continue;
          }
          const from = Math.max(off.startsAt.getTime(), dayStart);
          const to = Math.min(off.endsAt.getTime(), dayEnd);
          if (to <= from) {
            continue;
          }
          free = cut(free, { start: (from - dayStart) / 60000, end: (to - dayStart) / 60000 });
        }
        workMinutes += free.reduce((sum, item) => sum + (item.end - item.start), 0);
      }
      const minutes = busy.reduce((sum, row) => sum + row.totalDurationMin, 0);
      return {
        id: barber.id,
        name: barber.name,
        bookings: busy.length,
        minutes,
        workMinutes,
        occupancy: workMinutes === 0 ? null : Math.round((minutes * 100) / workMinutes),
        revenue: own.filter((row) => row.status === "completed").reduce((sum, row) => sum + row.totalPrice, 0),
      };
    }),
  };
}

export async function heatmapReport(period: Period) {
  const rows = await visits(period);
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!occupied.has(row.status)) {
      continue;
    }
    const date = dateKeyInZone(row.startsAt.getTime(), period.timeZone);
    const hour = Math.floor(localMinutes(row.startsAt, period.timeZone) / 60);
    const key = `${isoWeekday(date)}-${hour}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const hours = new Set<number>([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const cells = [...counts.entries()].map(([key, count]) => {
    const [weekday, hour] = key.split("-").map(Number);
    hours.add(hour);
    return { weekday, hour, count };
  });
  return { hours: [...hours].sort((left, right) => left - right), cells };
}

export async function cancellationsReport(period: Period) {
  const [rows, barbers] = await Promise.all([
    visits(period),
    prisma.barber.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true } }),
  ]);
  const cancelled = rows.filter((row) => row.status === "cancelled").length;
  const noShow = rows.filter((row) => row.status === "no_show").length;
  return {
    bookings: rows.length,
    cancelled,
    noShow,
    cancelShare: share(cancelled, rows.length),
    noShowShare: share(noShow, rows.length),
    byBarber: barbers
      .map((barber) => ({
        id: barber.id,
        name: barber.name,
        cancelled: rows.filter((row) => row.barberId === barber.id && row.status === "cancelled").length,
        noShow: rows.filter((row) => row.barberId === barber.id && row.status === "no_show").length,
      }))
      .filter((item) => item.cancelled > 0 || item.noShow > 0),
  };
}

export async function retentionReport(period: Period) {
  const rows = await visits(period);
  const completed = rows.filter((row) => row.status === "completed");
  const counts = new Map<string, number>();
  for (const row of completed) {
    counts.set(row.clientId, (counts.get(row.clientId) ?? 0) + 1);
  }
  const ids = [...counts.keys()];
  const earlier =
    ids.length === 0
      ? []
      : await prisma.booking.findMany({
          where: { status: "completed", startsAt: { lt: period.start }, clientId: { in: ids } },
          select: { clientId: true },
          distinct: ["clientId"],
        });
  const known = new Set(earlier.map((row) => row.clientId));
  let returning = 0;
  for (const [id, count] of counts) {
    if (count >= 2 || known.has(id)) {
      returning += 1;
    }
  }
  return { clients: counts.size, returning, share: share(returning, counts.size) };
}

function clockText(value: Date) {
  return `${value.getUTCHours().toString().padStart(2, "0")}:${value.getUTCMinutes().toString().padStart(2, "0")}`;
}
