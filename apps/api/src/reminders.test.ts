import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { buildApp } from "./routes.js";
import { setTelegramSender } from "./notify.js";
import { prisma } from "./prisma.js";
import { runReminders } from "./reminders.js";

const phone = "+998901110801";
const silentPhone = "+998901110802";
const chat = "88081";

const sent: { chatId: string; text: string }[] = [];

function token() {
  return randomBytes(24).toString("hex");
}

function overlaps(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("23P01") || message.includes("bookings_no_overlap");
}

after(async () => {
  setTelegramSender(null);
  await prisma.$disconnect();
});

test("напоминания уходят один раз, прошедший визит закрывается, отзыв просится после паузы", async () => {
  setTelegramSender(async (chatId, text) => {
    sent.push({ chatId, text });
  });
  const now = new Date();

  try {
    await prisma.$transaction(
      async (tx) => {
        const client = await tx.client.create({
          data: { name: "Напоминание", phone, telegramChatId: chat },
        });
        const silent = await tx.client.create({
          data: { name: "Без чата", phone: silentPhone },
        });

        const cut = { serviceId: "cut", name: "Стрижка", durationMin: 45, price: 80000 };
        const barbers = ["aziz", "timur", "sanjar"];

        async function book(
          clientId: string,
          startsAt: Date,
          status: "confirmed" | "cancelled" | "completed",
          preferred?: string,
        ) {
          const endsAt = new Date(startsAt.getTime() + 45 * 60_000);
          const order = preferred ? [preferred, ...barbers.filter((id) => id !== preferred)] : barbers;
          for (const barberId of order) {
            try {
              return await tx.booking.create({
                data: {
                  clientId,
                  barberId,
                  startsAt,
                  endsAt,
                  totalPrice: 80000,
                  totalDurationMin: 45,
                  status,
                  source: "web",
                  manageToken: token(),
                  services: { create: cut },
                },
              });
            } catch (error) {
              if (overlaps(error)) {
                continue;
              }
              throw error;
            }
          }
          throw new Error("нет свободного барбера");
        }

        const day = await book(client.id, new Date(now.getTime() + (1440 - 5) * 60_000), "confirmed", "aziz");
        const quiet = await book(silent.id, new Date(now.getTime() + (1440 - 8) * 60_000), "confirmed", "timur");
        const soon = await book(client.id, new Date(now.getTime() + 25 * 60_000), "confirmed", "aziz");
        const cancelled = await book(client.id, new Date(now.getTime() + 22 * 60_000), "cancelled", "sanjar");
        const fresh = await book(client.id, new Date(now.getTime() - 55 * 60_000), "confirmed", "aziz");
        const old = await book(client.id, new Date(now.getTime() - 5 * 60 * 60_000), "confirmed", "timur");
        const later = await book(client.id, new Date(now.getTime() + 10 * 60 * 60_000), "confirmed", "sanjar");

        const first = await runReminders(now, tx);
        assert.ok(first.day >= 1);
        assert.ok(first.soon >= 1);
        assert.ok(first.completed >= 2);
        assert.ok(first.reviews >= 1);
        assert.equal(sent.filter((item) => item.chatId === chat && item.text.startsWith("Напоминание: завтра")).length, 1);
        assert.equal(sent.filter((item) => item.chatId === chat && item.text.includes("через 30 минут")).length, 1);
        assert.equal(sent.filter((item) => item.chatId === chat && item.text.startsWith("Как прошёл визит")).length, 1);

        const marked = await tx.booking.findMany({
          where: { id: { in: [day.id, quiet.id, soon.id, cancelled.id, fresh.id, old.id, later.id] } },
        });
        const byId = new Map(marked.map((row) => [row.id, row]));
        assert.ok(byId.get(day.id)?.reminderDaySentAt);
        assert.equal(byId.get(day.id)?.reminder30mSentAt, null);
        assert.ok(byId.get(quiet.id)?.reminderDaySentAt);
        assert.ok(byId.get(soon.id)?.reminder30mSentAt);
        assert.equal(byId.get(cancelled.id)?.reminder30mSentAt, null);
        assert.equal(byId.get(fresh.id)?.status, "completed");
        assert.ok(byId.get(fresh.id)?.autoCompletedAt);
        assert.equal(byId.get(fresh.id)?.reviewRequestedAt, null);
        assert.equal(byId.get(old.id)?.status, "completed");
        assert.ok(byId.get(old.id)?.reviewRequestedAt);
        assert.equal(byId.get(later.id)?.status, "confirmed");
        assert.equal(byId.get(later.id)?.reminderDaySentAt, null);

        const before = sent.length;
        const second = await runReminders(now, tx);
        assert.equal(second.day, 0);
        assert.equal(second.soon, 0);
        assert.equal(second.reviews, 0);
        assert.equal(sent.length, before);

        throw new Error("ROLLBACK");
      },
      { timeout: 20_000 },
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "ROLLBACK") {
      throw error;
    }
  }

  const left = await prisma.client.count({ where: { phone: { in: [phone, silentPhone] } } });
  assert.equal(left, 0);

  process.env.CRON_SECRET = "";
  const app = buildApp();
  const missing = await app.inject({ method: "POST", url: "/internal/notifications" });
  assert.equal(missing.statusCode, 503);

  process.env.CRON_SECRET = "stage8-secret";
  const denied = await app.inject({
    method: "POST",
    url: "/internal/notifications",
    headers: { "x-cron-secret": "other" },
  });
  assert.equal(denied.statusCode, 401);
  delete process.env.CRON_SECRET;
});
