import { randomBytes } from "node:crypto";
import { prisma } from "./prisma.js";

const DAY = 24 * 60 * 60 * 1000;

export async function issueBarberLink(barberId: string, now = Date.now()) {
  const code = randomBytes(16).toString("hex");
  await prisma.barberLink.create({
    data: {
      code,
      barberId,
      expiresAt: new Date(now + DAY),
    },
  });
  return code;
}

export async function consumeBarberLink(code: string, chatId: string, now = Date.now()) {
  const link = await prisma.barberLink.findUnique({ where: { code } });
  if (!link || link.usedAt || link.expiresAt.getTime() <= now) {
    return null;
  }
  const spent = await prisma.barberLink.updateMany({
    where: { code, usedAt: null, expiresAt: { gt: new Date(now) } },
    data: { usedAt: new Date(now) },
  });
  if (spent.count !== 1) {
    return null;
  }
  const barber = await prisma.barber.update({
    where: { id: link.barberId },
    data: { telegramChatId: chatId },
  });
  return barber;
}
