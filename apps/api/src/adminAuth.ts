import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { ApiError } from "./errors.js";
import { hashPassword } from "./password.js";
import { prisma } from "./prisma.js";

const COOKIE = "polosa_admin";
const WEEK = 14 * 24 * 60 * 60;
const WINDOW_MS = 15 * 60_000;
const MAX_TRIES = 8;

const tries = new Map<string, { count: number; reset: number }>();

function envValue(key: string) {
  const current = process.env[key];
  if (current) {
    return current;
  }
  try {
    const text = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    const match = text.match(new RegExp(`^${key}="([^"]*)"`, "m"));
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

export function resetLoginLimits() {
  tries.clear();
}

function secret() {
  const value = envValue("ADMIN_SESSION_SECRET");
  if (value.length < 16) {
    throw new ApiError(503, "ADMIN_NOT_CONFIGURED", "В .env не задан ADMIN_SESSION_SECRET");
  }
  return value;
}

export function noteLoginFailure(ip: string) {
  const now = Date.now();
  const row = tries.get(ip);
  if (!row || row.reset < now) {
    tries.set(ip, { count: 1, reset: now + WINDOW_MS });
    return;
  }
  row.count += 1;
  if (row.count > MAX_TRIES) {
    throw new ApiError(429, "RATE_LIMIT", "Слишком много попыток. Подождите 15 минут.");
  }
}

export function assertLoginAllowed(ip: string) {
  const row = tries.get(ip);
  if (row && row.reset >= Date.now() && row.count > MAX_TRIES) {
    throw new ApiError(429, "RATE_LIMIT", "Слишком много попыток. Подождите 15 минут.");
  }
}

export function noteLoginSuccess(ip: string) {
  tries.delete(ip);
}

export function signSession(adminId: string) {
  const exp = Math.floor(Date.now() / 1000) + WEEK;
  const body = `${adminId}.${exp}`;
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function sessionCookie(token: string, maxAge = WEEK) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie() {
  return sessionCookie("", 0);
}

function readCookie(header: string | undefined) {
  const parts = (header ?? "").split(";").map((part) => part.trim());
  const hit = parts.find((part) => part.startsWith(`${COOKIE}=`));
  return hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : "";
}

export async function adminFromCookie(header: string | undefined) {
  const token = readCookie(header);
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [adminId, exp, sig] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(adminId) || !/^\d+$/.test(exp)) {
    return null;
  }
  const expected = createHmac("sha256", secret()).update(`${adminId}.${exp}`).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return null;
  }
  if (Number(exp) * 1000 < Date.now()) {
    return null;
  }
  return prisma.adminUser.findUnique({ where: { id: adminId }, select: { id: true, login: true } });
}

export async function ensureAdmin() {
  const login = envValue("ADMIN_LOGIN").trim();
  const password = envValue("ADMIN_PASSWORD");
  if (!login || password.length < 8) {
    return;
  }
  const existing = await prisma.adminUser.findUnique({ where: { login } });
  if (existing) {
    return;
  }
  const count = await prisma.adminUser.count();
  if (count > 0) {
    return;
  }
  await prisma.adminUser.create({
    data: { login, passwordHash: await hashPassword(password) },
  });
}
