import type { Update } from "@grammyjs/types";
import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import { ApiError } from "./errors.js";
import { consumeBarberLink } from "./links.js";
import { cancelBooking, listMyBookings } from "./bookings.js";
import { prisma } from "./prisma.js";
import { visitLabel } from "./notify.js";

const menu = new Keyboard().text("Записаться").text("Мои записи").resized().persistent();

let bot: Bot | null = null;
let botToken = "";

export function resetBot() {
  bot = null;
  botToken = "";
}

export function getBot(): Bot | null {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token) {
    return null;
  }
  if (!bot || botToken !== token) {
    bot = createBot(token);
    botToken = token;
  }
  return bot;
}

function bookingKeyboard(token: string) {
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  return new InlineKeyboard()
    .text("Отменить", `c:${token}`)
    .url("Запись на сайте", `${appUrl}/booking/${token}`);
}

async function linkGuest(clientId: string, telegramId: string, chatId: string) {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) {
    return "Запись не найдена";
  }
  if (client.telegramId && client.telegramId !== telegramId) {
    return "Эта запись уже привязана к другому Telegram.";
  }
  const taken = await prisma.client.findUnique({ where: { telegramId } });
  if (taken && taken.id !== client.id) {
    return "Этот Telegram уже привязан к другому гостю.";
  }
  await prisma.client.update({
    where: { id: client.id },
    data: { telegramId, telegramChatId: chatId },
  });
  return null;
}

export function createBot(token: string) {
  const username = (process.env.TELEGRAM_BOT_USERNAME ?? "polosa").replace(/^@/, "") || "polosa";
  const next = new Bot(token, {
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: "Полоса",
      username,
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    },
  });

  next.command("start", async (ctx) => {
    const payload = typeof ctx.match === "string" ? ctx.match.trim() : "";
    const chatId = String(ctx.chat.id);
    const telegramId = ctx.from ? String(ctx.from.id) : chatId;

    if (payload.startsWith("b_")) {
      const manageToken = payload.slice(2);
      const booking = await prisma.booking.findUnique({
        where: { manageToken },
        include: { services: true, barber: true },
      });
      if (!booking) {
        await ctx.reply("Запись не найдена.");
        return;
      }
      const problem = await linkGuest(booking.clientId, telegramId, chatId);
      if (problem) {
        await ctx.reply(problem);
        return;
      }
      const when = await visitLabel(booking.startsAt);
      const services = booking.services.map((service) => service.name).join(", ");
      await ctx.reply(`Ваша запись.\n${services}\n${booking.barber.name}\n${when}`, {
        reply_markup: bookingKeyboard(manageToken),
      });
      return;
    }

    if (payload.startsWith("barber_")) {
      const barber = await consumeBarberLink(payload.slice("barber_".length), chatId);
      await ctx.reply(barber ? `${barber.name}, уведомления о записях будут приходить сюда.` : "Ссылка уже использована или устарела.");
      return;
    }

    await ctx.reply("Полоса. Здесь можно посмотреть записи и открыть новую.", { reply_markup: menu });
  });

  next.hears("Записаться", async (ctx) => {
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    await ctx.reply("Новая запись открывается на сайте.", {
      reply_markup: new InlineKeyboard().url("Открыть запись", `${appUrl}/book`),
    });
  });

  next.hears("Мои записи", (ctx) => sendBookings(ctx));
  next.command("bookings", (ctx) => sendBookings(ctx));

  next.callbackQuery(/^c:([a-f0-9]{32,80})$/, async (ctx) => {
    const token = ctx.match[1] ?? "";
    try {
      await cancelBooking(token);
      await ctx.editMessageText("Запись отменена.");
      await ctx.answerCallbackQuery({ text: "Запись отменена" });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Не удалось отменить запись";
      await ctx.answerCallbackQuery({ text: message });
    }
  });

  return next;
}

async function sendBookings(ctx: Context) {
  if (!ctx.from) {
    await ctx.reply("Не удалось определить Telegram.");
    return;
  }
  const { bookings } = await listMyBookings(String(ctx.from.id));
  const active = bookings.filter((item) => item.status === "confirmed");
  if (active.length === 0) {
    await ctx.reply("Подтверждённых записей нет.");
    return;
  }
  const lines = active.map((item) => `${item.date} ${item.time} — ${item.services.map((service) => service.name).join(", ")}, ${item.barber.name}`);
  await ctx.reply(lines.join("\n"));
}

export async function installMenu() {
  const current = getBot();
  const secret = (process.env.TELEGRAM_BOT_TOKEN ?? "").split(":")[1] ?? "";
  if (!current || secret.length < 30) {
    return;
  }
  await current.api.setMyCommands([
    { command: "start", description: "Начать" },
    { command: "bookings", description: "Мои записи" },
  ]);
}

export async function handleTelegramUpdate(update: Update) {
  const current = getBot();
  if (!current) {
    return false;
  }
  await current.handleUpdate(update);
  return true;
}
