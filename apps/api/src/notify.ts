import { prisma } from "./prisma.js";
import { loadSettings } from "./schedule.js";
import { clockLabel, dateKeyInZone } from "./slots.js";

export type TelegramSender = (chatId: string, text: string) => Promise<void>;

let sender: TelegramSender | null = null;

export function setTelegramSender(next: TelegramSender | null) {
  sender = next;
}

function liveToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const secret = token.split(":")[1] ?? "";
  return secret.length >= 30 ? token : null;
}

export async function sendTelegram(chatId: string, text: string) {
  if (sender) {
    await sender(chatId, text);
    return;
  }
  const token = liveToken();
  if (!token) {
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    // Сообщение не должно откатывать уже сохранённую запись.
  }
}

export function telegramStartUrl(manageToken: string): string | null {
  const username = (process.env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9_]{4,32}$/.test(username)) {
    return null;
  }
  return `https://t.me/${username}?start=b_${manageToken}`;
}

export async function visitLabel(startsAt: Date): Promise<string> {
  const settings = await loadSettings();
  const key = dateKeyInZone(startsAt.getTime(), settings.timeZone);
  const [year, month, day] = key.split("-").map(Number);
  const date = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
  return `${date}, ${clockLabel(startsAt.getTime(), settings.timeZone)}`;
}

export async function notifyBookingChange(manageToken: string, kind: "created" | "cancelled" | "rescheduled") {
  const booking = await prisma.booking.findUnique({
    where: { manageToken },
    include: { client: true, barber: true, services: true },
  });
  if (!booking) {
    return;
  }
  const when = await visitLabel(booking.startsAt);
  const services = booking.services.map((service) => service.name).join(", ");
  const clientText =
    kind === "cancelled"
      ? `Запись отменена.\n${services}\n${when}`
      : kind === "rescheduled"
        ? `Запись перенесена на ${when}.\n${services}\n${booking.barber.name}`
        : `Запись подтверждена.\n${services}\n${booking.barber.name}\n${when}`;
  if (booking.client.telegramChatId) {
    await sendTelegram(booking.client.telegramChatId, clientText);
  }
  if (kind === "created" && booking.barber.telegramChatId) {
    await sendTelegram(
      booking.barber.telegramChatId,
      `Новая запись.\n${booking.client.name}\n${services}\n${when}`,
    );
  }
}
