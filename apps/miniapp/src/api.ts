import WebApp from "@twa-dev/sdk";

export type Service = {
  id: string;
  name: string;
  description: string;
  durationMin: number;
  price: number;
};

export type Barber = {
  id: string;
  name: string;
  bio: string;
  experienceYears: number;
  services: string[];
};

export type SlotItem = { label: string; startsAt: string };
export type DayItem = { date: string; open: boolean };

export type ManagedBooking = {
  status: string;
  startsAt: string;
  date: string;
  time: string;
  barber: { id: string; name: string };
  services: { id: string; name: string; durationMin: number; price: number }[];
  totalPrice: number;
  totalDurationMin: number;
  clientName: string;
  manageToken: string;
  canChange: boolean;
};

export class ApiRequestError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function initData(): string {
  return WebApp.initData;
}

function requestUrl(path: string) {
  const configured = (import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "https://barber15-mu.vercel.app" : ""))
    .trim()
    .replace(/\/+$/, "");
  if (!configured) {
    return path;
  }
  return `${configured}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const telegram = initData();
  if (telegram) {
    headers.set("x-telegram-init-data", telegram);
  }
  const response = await fetch(requestUrl(path), { ...init, headers });
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (!response.ok) {
    throw new ApiRequestError(response.status, body?.code ?? "INTERNAL", body?.message ?? "Не удалось выполнить запрос");
  }
  return body as T;
}
