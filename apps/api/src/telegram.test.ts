import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./errors.js";
import { signInitData, verifyInitData } from "./telegram.js";

const token = "123456:stage6-test";
const now = Date.parse("2026-10-05T10:00:00.000Z");

function sample(authDate = String(Math.floor(now / 1000))) {
  return signInitData(token, {
    auth_date: authDate,
    query_id: "AAE",
    user: JSON.stringify({ id: 4242, first_name: "Азиз", last_name: "Тест", username: "aziz" }),
  });
}

test("верная подпись возвращает пользователя Telegram", () => {
  const user = verifyInitData(sample(), token, now);
  assert.equal(user.id, "4242");
  assert.equal(user.firstName, "Азиз");
  assert.equal(user.lastName, "Тест");
  assert.equal(user.username, "aziz");
});

test("чужая подпись и просроченная сессия отклоняются", () => {
  assert.throws(() => verifyInitData(sample().replace(/hash=[^&]+/, "hash=ab"), token, now), (error: unknown) => {
    return error instanceof ApiError && error.code === "TELEGRAM_AUTH";
  });
  const old = String(Math.floor(now / 1000) - 25 * 60 * 60);
  assert.throws(() => verifyInitData(sample(old), token, now), (error: unknown) => {
    return error instanceof ApiError && error.statusCode === 401;
  });
});

test("пустой токен бота не пускает в Mini App", () => {
  assert.throws(() => verifyInitData(sample(), "", now), (error: unknown) => {
    return error instanceof ApiError && error.code === "TELEGRAM_NOT_CONFIGURED";
  });
});
