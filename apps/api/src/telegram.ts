import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.js";

export type TelegramUser = {
  id: string;
  firstName: string;
  lastName: string;
  username: string | null;
};

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function verifyInitData(initData: string, botToken: string, now = Date.now()): TelegramUser {
  if (!botToken) {
    throw new ApiError(503, "TELEGRAM_NOT_CONFIGURED", "В .env не задан TELEGRAM_BOT_TOKEN");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userRaw = params.get("user");
  if (!hash || !userRaw || !Number.isFinite(authDate)) {
    throw new ApiError(401, "TELEGRAM_AUTH", "Не удалось подтвердить Telegram");
  }

  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secret).update(dataCheck).digest("hex");
  const left = Buffer.from(computed);
  const right = Buffer.from(hash);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new ApiError(401, "TELEGRAM_AUTH", "Не удалось подтвердить Telegram");
  }

  const age = now - authDate * 1000;
  if (age > MAX_AGE_MS || age < -60_000) {
    throw new ApiError(401, "TELEGRAM_AUTH", "Сессия Telegram устарела. Откройте приложение снова.");
  }

  let user: { id?: number | string; first_name?: string; last_name?: string; username?: string };
  try {
    user = JSON.parse(userRaw) as typeof user;
  } catch {
    throw new ApiError(401, "TELEGRAM_AUTH", "Не удалось подтвердить Telegram");
  }
  if (user.id === undefined || user.id === null || String(user.id).length === 0) {
    throw new ApiError(401, "TELEGRAM_AUTH", "Не удалось подтвердить Telegram");
  }

  return {
    id: String(user.id),
    firstName: user.first_name?.trim() || "Гость",
    lastName: user.last_name?.trim() || "",
    username: user.username ?? null,
  };
}

export function signInitData(
  botToken: string,
  fields: Record<string, string>,
): string {
  const params = new URLSearchParams(fields);
  const dataCheck = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheck).digest("hex");
  params.set("hash", hash);
  return params.toString();
}
