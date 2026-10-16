// Run with: npm test   (sets TZ=Europe/Berlin so DST behaviour is checked)
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { expandRecurrence } from "../dist/services/recurrence.js";

// Local wall-clock helpers (independent of the implementation).
const L = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0);
const fmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const run = (rule, first, from, to, max = 500) => expandRecurrence(rule, first, from, to, max).dates.map(fmt);

test("runs in a DST zone", () => {
  assert.equal(process.env.TZ, "Europe/Berlin");
  assert.notEqual(L(2026, 10, 24, 12).getTimezoneOffset(), L(2026, 10, 26, 12).getTimezoneOffset());
});

test("weekly Friday series that began months ago shows up today (the Clean Sheets Kids case)", () => {
  // Series started Fri 2026-01-09 17:00, weekly.
  const r = run("FREQ=WEEKLY;INTERVAL=1", L(2026, 1, 9, 17), L(2026, 10, 16), L(2026, 10, 17));
  assert.deepEqual(r, ["2026-10-16 17:00"]);
});

test("weekly keeps wall-clock time across the DST change on 2026-10-25", () => {
  const r = run("FREQ=WEEKLY", L(2026, 1, 9, 17), L(2026, 10, 9), L(2026, 11, 7));
  assert.deepEqual(r, ["2026-10-09 17:00", "2026-10-16 17:00", "2026-10-23 17:00", "2026-10-30 17:00", "2026-11-06 17:00"]);
});

test("range before the series started yields nothing", () => {
  assert.deepEqual(run("FREQ=WEEKLY", L(2026, 10, 16, 17), L(2026, 10, 1), L(2026, 10, 15)), []);
});

test("weekly with INTERVAL=2 and BYDAY", () => {
  const r = run("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", L(2026, 10, 5, 9), L(2026, 10, 1), L(2026, 11, 10));
  assert.deepEqual(r, ["2026-10-05 09:00", "2026-10-07 09:00", "2026-10-19 09:00", "2026-10-21 09:00", "2026-11-02 09:00", "2026-11-04 09:00"]);
});

test("daily with INTERVAL", () => {
  assert.deepEqual(run("FREQ=DAILY;INTERVAL=3", L(2026, 10, 1, 8), L(2026, 10, 10), L(2026, 10, 20)), [
    "2026-10-10 08:00", "2026-10-13 08:00", "2026-10-16 08:00", "2026-10-19 08:00"
  ]);
});

test("COUNT counts from the series start, not from the range", () => {
  // 4 occurrences: Oct 1, 8, 15, 22 -> asking for November must give nothing, asking for Oct 15+ gives 2.
  assert.deepEqual(run("FREQ=WEEKLY;COUNT=4", L(2026, 10, 1, 10), L(2026, 11, 1), L(2026, 12, 1)), []);
  assert.deepEqual(run("FREQ=WEEKLY;COUNT=4", L(2026, 10, 1, 10), L(2026, 10, 15), L(2026, 12, 1)), ["2026-10-15 10:00", "2026-10-22 10:00"]);
});

test("UNTIL (UTC and date-only) ends the series", () => {
  assert.deepEqual(run("FREQ=WEEKLY;UNTIL=20261014T220000Z", L(2026, 10, 1, 17), L(2026, 10, 1), L(2026, 12, 1)), ["2026-10-01 17:00", "2026-10-08 17:00"]);
  assert.deepEqual(run("FREQ=DAILY;UNTIL=20261003", L(2026, 10, 1, 17), L(2026, 10, 1), L(2026, 12, 1)), ["2026-10-01 17:00", "2026-10-02 17:00", "2026-10-03 17:00"]);
});

test("monthly: same day of month, skips months that lack it", () => {
  assert.deepEqual(run("FREQ=MONTHLY", L(2026, 1, 31, 12), L(2026, 1, 1), L(2026, 6, 1)), ["2026-01-31 12:00", "2026-03-31 12:00", "2026-05-31 12:00"]);
});

test("monthly: BYDAY with ordinals (2nd Tuesday, last Friday)", () => {
  assert.deepEqual(run("FREQ=MONTHLY;BYDAY=2TU", L(2026, 1, 13, 18), L(2026, 10, 1), L(2026, 12, 31)), ["2026-10-13 18:00", "2026-11-10 18:00", "2026-12-08 18:00"]);
  assert.deepEqual(run("FREQ=MONTHLY;BYDAY=-1FR", L(2026, 1, 30, 18), L(2026, 10, 1), L(2026, 12, 31)), ["2026-10-30 18:00", "2026-11-27 18:00", "2026-12-25 18:00"]);
});

test("monthly: BYMONTHDAY incl. negative, and BYSETPOS", () => {
  assert.deepEqual(run("FREQ=MONTHLY;BYMONTHDAY=1,-1", L(2026, 1, 1, 9), L(2026, 10, 1), L(2026, 11, 30, 23)), ["2026-10-01 09:00", "2026-10-31 09:00", "2026-11-01 09:00", "2026-11-30 09:00"]);
  assert.deepEqual(run("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", L(2026, 1, 30, 9), L(2026, 10, 1), L(2026, 12, 1)), ["2026-10-30 09:00", "2026-11-30 09:00"]);
});

test("yearly: birthday-style and BYMONTH", () => {
  assert.deepEqual(run("FREQ=YEARLY", L(2020, 3, 14, 0), L(2026, 1, 1), L(2028, 1, 1)), ["2026-03-14 00:00", "2027-03-14 00:00"]);
  assert.deepEqual(run("FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=1", L(2020, 3, 1, 0), L(2026, 1, 1), L(2027, 1, 1)), ["2026-03-01 00:00", "2026-09-01 00:00"]);
});

test("unsupported FREQ is reported, not silently dropped", () => {
  const r = expandRecurrence("FREQ=HOURLY", L(2026, 1, 1, 1), L(2026, 1, 1), L(2026, 2, 1), 10);
  assert.equal(r.unsupported, "FREQ=HOURLY");
});

test("maxResults caps output", () => {
  assert.equal(run("FREQ=DAILY", L(2026, 1, 1, 8), L(2026, 1, 1), L(2027, 1, 1), 5).length, 5);
});

test("toString() injection into a JXA-like script works standalone (no outer scope needed)", () => {
  const src = `(function(){ const expandRecurrence = ${expandRecurrence.toString()}; return expandRecurrence; })()`;
  const injected = vm.runInNewContext(src, {});
  const r = injected("FREQ=WEEKLY", L(2026, 1, 9, 17), L(2026, 10, 16), L(2026, 10, 17), 10);
  assert.equal(r.dates.length, 1);
  assert.equal(fmt(new Date(r.dates[0].getTime())), "2026-10-16 17:00");
});
