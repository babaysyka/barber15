import { Prisma } from "@prisma/client";
import { sendTelegram } from "./notify.js";
import { prisma } from "./prisma.js";
import { clockLabel, dateKeyInZone } from "./slots.js";

type Db = Prisma.TransactionClient | typeof prisma;

/** Запас шире шага cron (5 минут), чтобы один пропуск не терял окно. */
export const REMINDER_GRACE_MIN = 20;

const defaults = {
  dayMin: 1440,
  soonMin: 30,
  reviewDelayMin: 60,
  timeZone: "Asia/Tashkent",
};

export function reminderWindow(now: Date, leadMin: number) {
  const minute = 60_000;
  const after = new Date(now.getTime() + (leadMin - REMINDER_GRACE_MIN) * minute);
  return {
    after: after > now ? after : now,
    until: new Date(now.getTime() + leadMin * minute),
  };
}

export function reminderText(kind: "day" | "soon" | "review", when: string, services: string, barber: string) {
  const head =
    kind === "day"
      ? "Напоминание: завтра ждём вас."
      : kind === "soon"
        ? "Напоминание: визит через 30 минут."
        : "Как прошёл визит? Напишите оценку от 1 до 5.";
  return `${head}\n${services}\n${barber}\n${when}`;
}

function whenLabel(startsAt: Date, timeZone: string) {
  const key = dateKeyInZone(startsAt.getTime(), timeZone);
  const [year, month, day] = key.split("-").map(Number);
  const date = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
  return `${date}, ${clockLabel(startsAt.getTime(), timeZone)}`;
}

async function reminderSettings(db: Db) {
  const rows = await db.setting.findMany({
    where: {
      key: { in: ["reminder_day_minutes", "reminder_short_minutes", "review_delay_min", "timezone"] },
    },
  });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  const read = (key: string, fallback: number) => {
    const value = Number(map.get(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    dayMin: read("reminder_day_minutes", defaults.dayMin),
    soonMin: read("reminder_short_minutes", defaults.soonMin),
    reviewDelayMin: read("review_delay_min", defaults.reviewDelayMin),
    timeZone: map.get("timezone") || defaults.timeZone,
  };
}

const include = { client: true, barber: true, services: true } as const;

async function tell(
  db: Db,
  booking: Awaited<ReturnType<typeof prisma.booking.findMany<{ include: typeof include }>>>[number],
  kind: "day" | "soon" | "review",
  timeZone: string,
) {
  const stamp = new Date();
  const claim =
    kind === "day"
      ? await db.booking.updateMany({
          where: { id: booking.id, status: "confirmed", reminderDaySentAt: null },
          data: { reminderDaySentAt: stamp },
        })
      : kind === "soon"
        ? await db.booking.updateMany({
            where: { id: booking.id, status: "confirmed", reminder30mSentAt: null },
            data: { reminder30mSentAt: stamp },
          })
        : await db.booking.updateMany({
            where: { id: booking.id, status: "completed", reviewRequestedAt: null },
            data: { reviewRequestedAt: stamp },
          });
  if (claim.count !== 1) {
    return 0;
  }
  const chatId = booking.client.telegramChatId;
  if (!chatId) {
    return 0;
  }
  const services = booking.services.map((service) => service.name).join(", ");
  await sendTelegram(chatId, reminderText(kind, whenLabel(booking.startsAt, timeZone), services, booking.barber.name));
  return 1;
}

export async function runReminders(now = new Date(), db: Db = prisma) {
  const settings = await reminderSettings(db);
  const day = reminderWindow(now, settings.dayMin);
  const soon = reminderWindow(now, settings.soonMin);

  const dayRows = await db.booking.findMany({
    where: {
      status: "confirmed",
      reminderDaySentAt: null,
      startsAt: { gt: day.after, lte: day.until },
    },
    include,
  });
  let daySent = 0;
  for (const booking of dayRows) {
    daySent += await tell(db, booking, "day", settings.timeZone);
  }

  const soonRows = await db.booking.findMany({
    where: {
      status: "confirmed",
      reminder30mSentAt: null,
      startsAt: { gt: soon.after, lte: soon.until },
    },
    include,
  });
  let soonSent = 0;
  for (const booking of soonRows) {
    soonSent += await tell(db, booking, "soon", settings.timeZone);
  }

  const completed = await db.booking.updateMany({
    where: { status: "confirmed", endsAt: { lt: now }, autoCompletedAt: null },
    data: { status: "completed", autoCompletedAt: now },
  });

  const reviewBefore = new Date(now.getTime() - settings.reviewDelayMin * 60_000);
  const reviewRows = await db.booking.findMany({
    where: { status: "completed", reviewRequestedAt: null, endsAt: { lt: reviewBefore } },
    include,
  });
  let reviews = 0;
  for (const booking of reviewRows) {
    reviews += await tell(db, booking, "review", settings.timeZone);
  }

  return { day: daySent, soon: soonSent, completed: completed.count, reviews };
}
