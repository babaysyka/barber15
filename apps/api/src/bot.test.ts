import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import type { Update } from "@grammyjs/types";
import { buildApp } from "./routes.js";
import { getBot, resetBot } from "./bot.js";
import { issueBarberLink } from "./links.js";
import { notifyBookingChange, setTelegramSender } from "./notify.js";
import { prisma } from "./prisma.js";

const phone = "+998901110301";
const token = "123456:stage7";
const barberId = "timur";
let previousChat: string | null = null;

const sent: { method: string; text?: string }[] = [];

function message(updateId: number, text: string, commandLength?: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 88001, type: "private", first_name: "Бот" },
      from: { id: 88001, is_bot: false, first_name: "Бот" },
      text,
      entities: commandLength ? [{ type: "bot_command", offset: 0, length: commandLength }] : undefined,
    },
  } as Update;
}

async function cleanup() {
  await prisma.booking.deleteMany({ where: { client: { phone } } });
  await prisma.client.deleteMany({ where: { OR: [{ phone }, { telegramId: "88001" }] } });
  await prisma.barberLink.deleteMany({ where: { barberId } });
  await prisma.barber.update({ where: { id: barberId }, data: { telegramChatId: previousChat } });
  setTelegramSender(null);
}

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("бот связывает гостя, принимает меню и одноразовую ссылку барбера", async () => {
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_BOT_USERNAME = "polosa_test_bot";
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  resetBot();
  const current = getBot();
  assert.ok(current);
  current.api.config.use(async (_prev, method, payload) => {
    const body = payload as { text?: string };
    sent.push({ method, text: body.text });
    if (method === "getMe") {
      return { ok: true, result: { id: 1, is_bot: true, first_name: "Полоса", username: "polosa_test_bot" } } as never;
    }
    return {
      ok: true,
      result:
        method === "sendMessage" || method === "editMessageText"
          ? { message_id: 1, date: 0, chat: { id: 88001, type: "private" as const }, text: body.text ?? "" }
          : true,
    } as never;
  });

  const barber = await prisma.barber.findUnique({ where: { id: barberId }, select: { telegramChatId: true } });
  previousChat = barber?.telegramChatId ?? null;
  await cleanup();
  previousChat = barber?.telegramChatId ?? null;

  const app = buildApp();
  try {
    const missing = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "nope" },
      payload: { update_id: 1 },
    });
    assert.equal(missing.statusCode, 200, JSON.stringify(missing.json()));

    process.env.TELEGRAM_WEBHOOK_SECRET = "stage7-secret";
    const denied = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: { update_id: 1 },
    });
    assert.equal(denied.statusCode, 401);
    process.env.TELEGRAM_WEBHOOK_SECRET = "";

    const manageToken = randomBytes(24).toString("hex");
    await prisma.client.create({ data: { name: "Гость Бота", phone } });
    const client = await prisma.client.findUniqueOrThrow({ where: { phone } });
    await prisma.booking.create({
      data: {
        clientId: client.id,
        barberId: "aziz",
        startsAt: new Date("2026-12-01T05:00:00.000Z"),
        endsAt: new Date("2026-12-01T05:45:00.000Z"),
        totalPrice: 80000,
        totalDurationMin: 45,
        status: "confirmed",
        source: "web",
        manageToken,
        services: { create: [{ serviceId: "cut", name: "Мужская стрижка", durationMin: 45, price: 80000 }] },
      },
    });

    const opened = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: message(2, `/start b_${manageToken}`, 6),
    });
    assert.equal(opened.statusCode, 200);
    const linked = await prisma.client.findUniqueOrThrow({ where: { phone } });
    assert.equal(linked.telegramId, "88001");
    assert.equal(linked.telegramChatId, "88001");
    assert.equal(sent.some((item) => item.text?.includes("Мужская стрижка")), true);

    sent.length = 0;
    const menu = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: message(3, "Мои записи"),
    });
    assert.equal(menu.statusCode, 200);
    assert.equal(sent.some((item) => item.text?.includes("2026-12-01")), true);

    const messages: { chatId: string; text: string }[] = [];
    setTelegramSender(async (chatId, text) => {
      messages.push({ chatId, text });
    });
    const aziz = await prisma.barber.findUnique({ where: { id: "aziz" }, select: { telegramChatId: true } });
    await prisma.barber.update({ where: { id: "aziz" }, data: { telegramChatId: "99001" } });
    await notifyBookingChange(manageToken, "created");
    assert.equal(messages.some((item) => item.chatId === "88001" && item.text.includes("подтверждена")), true);
    assert.equal(messages.some((item) => item.chatId === "99001" && item.text.includes("Новая запись")), true);
    await prisma.barber.update({ where: { id: "aziz" }, data: { telegramChatId: aziz?.telegramChatId ?? null } });
    setTelegramSender(null);

    const code = await issueBarberLink(barberId);
    const bound = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: message(4, `/start barber_${code}`, 6),
    });
    assert.equal(bound.statusCode, 200);
    const master = await prisma.barber.findUniqueOrThrow({ where: { id: barberId } });
    assert.equal(master.telegramChatId, "88001");
    const again = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: message(5, `/start barber_${code}`, 6),
    });
    assert.equal(again.statusCode, 200);
    assert.equal(sent.some((item) => item.text?.includes("уже использована")), true);

    const cancelled = await app.inject({
      method: "POST",
      url: "/telegram/webhook",
      payload: {
        update_id: 6,
        callback_query: {
          id: "cb",
          from: { id: 88001, is_bot: false, first_name: "Бот" },
          chat_instance: "1",
          data: `c:${manageToken}`,
          message: {
            message_id: 10,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 88001, type: "private", first_name: "Бот" },
            text: "Ваша запись",
          },
        },
      },
    });
    assert.equal(cancelled.statusCode, 200);
    const saved = await prisma.booking.findUniqueOrThrow({ where: { manageToken } });
    assert.equal(saved.status, "cancelled");

    const card = await app.inject({ method: "GET", url: `/api/v1/bookings/${manageToken}` });
    assert.equal(
      (card.json() as { booking: { telegramUrl: string } }).booking.telegramUrl,
      `https://t.me/polosa_test_bot?start=b_${manageToken}`,
    );
  } finally {
    await app.close();
  }
});
