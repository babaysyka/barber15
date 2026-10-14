import assert from "node:assert/strict";
import test from "node:test";
import { canChangeAt, computeSlots, type SlotQuery } from "./slots.js";

const TZ = "Asia/Tashkent";

function query(patch: Partial<SlotQuery> = {}): SlotQuery {
  return {
    now: Date.parse("2026-10-05T00:00:00.000Z"),
    date: "2026-10-05",
    timeZone: TZ,
    durationMin: 60,
    slotStepMin: 30,
    minNoticeMin: 0,
    horizonDays: 30,
    work: { start: "10:00", end: "12:00" },
    breaks: [],
    blocked: [],
    ...patch,
  };
}

test("слоты встают на сетку и последний помещается ровно к закрытию", () => {
  const slots = computeSlots(query());
  assert.deepEqual(
    slots.map((slot) => slot.label),
    ["10:00", "10:30", "11:00"],
  );
  assert.equal(slots[0]?.startsAt, "2026-10-05T05:00:00.000Z");
});

test("обед вырезает пересекающие старты", () => {
  const slots = computeSlots(
    query({
      durationMin: 30,
      slotStepMin: 30,
      work: { start: "10:00", end: "12:00" },
      breaks: [{ start: "10:30", end: "11:00" }],
    }),
  );
  assert.deepEqual(
    slots.map((slot) => slot.label),
    ["10:00", "11:00", "11:30"],
  );
});

test("длинная услуга не начинается, если не помещается между обедом и закрытием", () => {
  const slots = computeSlots(
    query({
      durationMin: 60,
      breaks: [{ start: "10:30", end: "11:30" }],
    }),
  );
  assert.deepEqual(slots, []);
});

test("существующая запись и исключение занимают интервал", () => {
  const slots = computeSlots(
    query({
      durationMin: 30,
      slotStepMin: 30,
      blocked: [
        {
          start: Date.parse("2026-10-05T05:00:00.000Z"),
          end: Date.parse("2026-10-05T05:30:00.000Z"),
        },
        {
          start: Date.parse("2026-10-05T06:00:00.000Z"),
          end: Date.parse("2026-10-05T06:30:00.000Z"),
        },
      ],
    }),
  );
  assert.deepEqual(
    slots.map((slot) => slot.label),
    ["10:30", "11:30"],
  );
});

test("min_notice отсекает слишком близкие старты", () => {
  const slots = computeSlots(
    query({
      now: Date.parse("2026-10-05T05:01:00.000Z"),
      minNoticeMin: 30,
      durationMin: 30,
    }),
  );
  assert.deepEqual(
    slots.map((slot) => slot.label),
    ["11:00", "11:30"],
  );
});

test("горизонт и прошедший день не отдают слоты", () => {
  assert.equal(computeSlots(query({ date: "2026-10-04" })).length, 0);
  assert.equal(computeSlots(query({ date: "2026-11-05", horizonDays: 30 })).length, 0);
  assert.equal(computeSlots(query({ work: null })).length, 0);
});

test("отмена возможна ровно до cutoff и невозможна позже", () => {
  const startsAt = Date.parse("2026-10-05T10:00:00.000Z");
  assert.equal(canChangeAt(startsAt, startsAt - 30 * 60_000, 30), true);
  assert.equal(canChangeAt(startsAt, startsAt - 29 * 60_000, 30), false);
});
