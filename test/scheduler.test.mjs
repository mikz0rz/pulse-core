// Tests for the working-hours (day/night) cadence — the boundary arithmetic in
// nextCycleDelayMs. Run against the compiled output (`npm test` builds first),
// and kept out of src/ so nothing here is published in `build/`.
//
// Fixtures are UTC instants; Europe/Vilnius is UTC+2 (EET) across the November
// 2026 dates used below, so local time = UTC + 2. Each fixture's intended local
// time is written in the comment beside it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCycleDelayMs } from "../build/scheduler.js";

const MIN = 60 * 1000;

// Mon-Fri 09:00-18:00 Vilnius, 30-minute interval in the window, 4h outside.
const POLICY = {
  timeZone: "Europe/Vilnius",
  startHour: 9,
  endHour: 18,
  days: [1, 2, 3, 4, 5],
  quietIntervalMinutes: 240,
};

const ACTIVE = 30;
const at = (iso) => Date.parse(iso);
const delay = (iso, active = ACTIVE, policy = POLICY, stagger = 0) =>
  nextCycleDelayMs(active, policy, at(iso), stagger);

const minutes = (iso, ...rest) => delay(iso, ...rest) / MIN;

test("no policy keeps the plain fixed interval", () => {
  assert.equal(delay("2026-11-02T03:00:00Z", ACTIVE, null), 30 * MIN);
  assert.equal(delay("2026-11-02T16:00:00Z", ACTIVE, null), 30 * MIN);
});

test("inside the window uses the source's own interval", () => {
  assert.equal(minutes("2026-11-02T07:00:00Z"), 30); // Mon 09:00 — start is inclusive
  assert.equal(minutes("2026-11-02T14:30:00Z"), 30); // Mon 16:30
  // 17:59 is still inside: the delay must NOT be truncated toward the 18:00 close.
  assert.equal(minutes("2026-11-02T15:59:00Z"), 30); // Mon 17:59
});

test("outside the window never sleeps past the next opening", () => {
  assert.equal(minutes("2026-11-02T06:45:00Z"), 15); // Mon 08:45 -> opening in 15m
  assert.equal(minutes("2026-11-02T05:00:00Z"), 120); // Mon 07:00 -> capped to the 2h opening, not the 4h quiet
});

test("a cycle landing just before the opening does not burn an extra one", () => {
  // Mon 08:59 — one minute out. Capping here would wake at 09:00 and then again
  // at 09:01. Inside the 5-minute grace, so it takes the full active interval.
  assert.equal(minutes("2026-11-02T06:59:00Z"), 30);
  assert.equal(minutes("2026-11-02T06:55:00Z"), 30); // Mon 08:55
});

test("overnight falls back to the quiet interval", () => {
  assert.equal(minutes("2026-11-02T16:00:00Z"), 240); // Mon 18:00
  assert.equal(minutes("2026-11-02T22:00:00Z"), 240); // Tue 00:00
});

test("the weekend gap resolves to Monday, not to fake weekend openings", () => {
  assert.equal(minutes("2026-11-06T16:00:00Z"), 240); // Fri 18:00 -> Mon 09:00 is 63h away
  assert.equal(minutes("2026-11-07T10:00:00Z"), 240); // Sat 12:00
  assert.equal(minutes("2026-11-08T21:00:00Z"), 240); // Sun 23:00
  assert.equal(minutes("2026-11-09T05:00:00Z"), 120); // Mon 07:00 -> 2h to Monday's opening
  assert.equal(minutes("2026-11-09T06:30:00Z"), 30); // Mon 08:30 -> capped to the 30m opening
});

test("a source slower than the quiet interval keeps its own cadence", () => {
  // 12h RSS feed: the window must not drag it UP to 4h overnight.
  assert.equal(minutes("2026-11-02T16:00:00Z", 720), 720); // Mon 18:00
  assert.equal(minutes("2026-11-07T10:00:00Z", 720), 720); // Sat 12:00
  // ...and inside the window it is still its own interval.
  assert.equal(minutes("2026-11-02T07:00:00Z", 720), 720);
});

test("a source faster than the quiet interval is slowed to it", () => {
  assert.equal(minutes("2026-11-02T16:00:00Z", 20), 240); // 20-min source, Mon 18:00
});

test("the opening cap carries each source's stagger", () => {
  // Mon 08:45 -> 15m to the opening, plus this source's 10s offset.
  assert.equal(delay("2026-11-02T06:45:00Z", ACTIVE, POLICY, 10_000), 15 * MIN + 10_000);
});

test("every day in `days` opens, and none outside it does", () => {
  // Mon..Fri at 08:45 local (06:45 UTC) should each reach their own 09:00.
  for (const iso of ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]) {
    assert.equal(minutes(`${iso}T06:45:00Z`), 15, iso);
  }
  // Sat/Sun at the same local time are outside the window entirely.
  assert.equal(minutes("2026-11-07T06:45:00Z"), 240); // Sat 08:45
  assert.equal(minutes("2026-11-08T06:45:00Z"), 240); // Sun 08:45
});

test("a policy with no days at all never opens", () => {
  const noDays = { ...POLICY, days: [] }; // empty falls back to Mon-Fri
  assert.equal(minutes("2026-11-02T07:00:00Z", ACTIVE, noDays), 30);
});

test("a full overnight run walks to the opening", () => {
  // Walk the loop the scheduler actually runs: apply each delay, recompute.
  let now = at("2026-11-02T16:00:00Z"); // Mon 18:00
  const stops = [];
  for (let i = 0; i < 8; i++) {
    now += nextCycleDelayMs(ACTIVE, POLICY, now, 0);
    stops.push(new Date(now).toISOString());
    if (now >= at("2026-11-03T07:00:00Z")) break; // past Tue 09:00
  }
  assert.deepEqual(stops, [
    "2026-11-02T20:00:00.000Z", // Mon 22:00
    "2026-11-03T00:00:00.000Z", // Tue 02:00
    "2026-11-03T04:00:00.000Z", // Tue 06:00
    "2026-11-03T07:00:00.000Z", // Tue 09:00 — capped to the opening
  ]);
});

test("DST transitions do not produce a bad delay", () => {
  // Europe/Vilnius: clocks go back 2026-10-25, forward 2027-03-28, both ~03:00-04:00
  // local on a Sunday. Monday 09:00 is always far enough away that the cap is
  // unaffected, but assert the invariant across the whole weekend anyway.
  for (const iso of [
    "2026-10-24T21:00:00Z", "2026-10-25T01:00:00Z", "2026-10-25T02:00:00Z",
    "2026-10-25T12:00:00Z", "2026-10-26T06:00:00Z",
    "2027-03-27T21:00:00Z", "2027-03-28T01:00:00Z", "2027-03-28T12:00:00Z",
  ]) {
    const ms = delay(iso);
    assert.ok(Number.isFinite(ms) && ms > 0, `${iso} -> ${ms}`);
    assert.ok(ms >= MIN && ms <= 1440 * MIN, `${iso} -> ${ms} out of range`);
  }
});

test("malformed input never yields a spinning or unbounded delay", () => {
  const bad = [
    [NaN, POLICY],
    [0, POLICY],
    [-30, POLICY],
    [ACTIVE, { ...POLICY, quietIntervalMinutes: NaN }],
    [ACTIVE, { ...POLICY, quietIntervalMinutes: 0 }],
    [ACTIVE, { ...POLICY, days: [1, 1] }], // duplicates: harmless, still schedules
  ];
  for (const [active, policy] of bad) {
    const ms = nextCycleDelayMs(active, policy, at("2026-11-02T16:00:00Z"), 0);
    assert.ok(Number.isFinite(ms) && ms > 0, `${active} / ${JSON.stringify(policy)} -> ${ms}`);
    assert.ok(ms >= MIN && ms <= 1440 * MIN, `${active} -> ${ms} out of range`);
  }
});
