// Tests for the scheduler's pure decision functions: the working-hours
// (day/night) boundary arithmetic in nextCycleDelayMs, and the digest
// full/incremental/skip choice in planDigest. Run against the compiled output
// (`npm test` builds first), and kept out of src/ so nothing here is published
// in `build/`.
//
// Fixtures are UTC instants; Europe/Vilnius is UTC+2 (EET) across the November
// 2026 dates used below, so local time = UTC + 2. Each fixture's intended local
// time is written in the comment beside it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCycleDelayMs, planDigest, DIGEST_FULL_REBUILD_MS } from "../build/scheduler.js";

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

// ─── planDigest: how each cycle regenerates the TL;DR ───────────────────────
//
// The planner is pure and takes its "now" as an argument, so a whole day of
// cycles can be replayed in a loop (see the 12h-rebuild test at the bottom).

const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-02T10:00:00Z"); // Mon 12:00 Vilnius
const iso = (ms) => new Date(ms).toISOString();

/** A story. `createdAt` is the insert time (the split key); `itemTimestamp` the post time. */
const story = (createdAtMs, itemTimestampMs = createdAtMs) => ({
  createdAt: iso(createdAtMs),
  itemTimestamp: iso(itemTimestampMs),
});

/** A stored digest whose last write (and last full rebuild) was `ageMs` ago. */
const digest = (ageMs, bullets = ["a bullet"], fullRebuildAgeMs = ageMs) => ({
  bullets,
  generatedAt: iso(NOW - ageMs),
  fullRebuildAt: iso(NOW - fullRebuildAgeMs),
});

const plan = (windowItems, previous, extra = {}) =>
  planDigest({ windowItems, previous, now: NOW, incrementalEnabled: true, ...extra });

/** N already-digested stories, spread back from an hour ago. */
const oldStories = (n) => Array.from({ length: n }, (_, i) => story(NOW - HOUR - i * MIN));

test("an empty window is skipped outright", () => {
  assert.deepEqual(plan([], digest(30 * MIN)), { mode: "skip", reason: "empty-window" });
});

test("with incremental off, every cycle rebuilds in full", () => {
  const p = plan([...oldStories(20), story(NOW - MIN)], digest(30 * MIN), { incrementalEnabled: false });
  assert.equal(p.mode, "full");
  assert.equal(p.reason, "disabled");
  assert.equal(p.items.length, 21);
  assert.equal(p.itemCount, 21);
});

test("no previous digest, or one with no bullets, rebuilds in full", () => {
  const items = oldStories(4);
  assert.equal(plan(items, null).reason, "no-previous");
  assert.equal(plan(items, undefined).reason, "no-previous");
  assert.equal(plan(items, digest(30 * MIN, [])).reason, "no-previous");
});

test("the rebuild fires at exactly 12h and not a millisecond earlier", () => {
  const items = [...oldStories(4), story(NOW - MIN)];
  assert.equal(
    plan(items, digest(30 * MIN, ["b"], DIGEST_FULL_REBUILD_MS - 1)).reason,
    "incremental",
    "1ms short of the interval is still incremental"
  );
  assert.equal(
    plan(items, digest(30 * MIN, ["b"], DIGEST_FULL_REBUILD_MS)).reason,
    "rebuild-due",
    "the boundary is inclusive"
  );
});

test("timestamps that cannot be trusted rebuild in full", () => {
  const items = oldStories(4);
  // Unparseable rebuild marker — a column that somehow never got backfilled.
  assert.equal(
    plan(items, { bullets: ["b"], generatedAt: iso(NOW - 30 * MIN), fullRebuildAt: "not a date" }).reason,
    "bad-timestamp"
  );
  // Never rebuilt since the column existed.
  assert.equal(plan(items, { bullets: ["b"], generatedAt: iso(NOW - HOUR), fullRebuildAt: null }).reason, "bad-timestamp");
  // Unparseable cursor / marker.
  assert.equal(plan(items, { bullets: ["b"], generatedAt: "not a date", fullRebuildAt: iso(NOW) }).reason, "bad-timestamp");
  // A clock that moved backwards: the cursor would be in the future.
  assert.equal(plan(items, digest(-HOUR)).reason, "bad-timestamp");
  assert.equal(plan(items, digest(HOUR, ["b"], -HOUR)).reason, "bad-timestamp");
  assert.equal(plan(items, digest(HOUR), { now: NaN }).reason, "bad-timestamp");
  // One unparseable item poisons the split, so don't trust any of it.
  assert.equal(plan([...items, { createdAt: "garbage" }], digest(30 * MIN)).reason, "bad-timestamp");
});

test("the split uses insert time, not post time", () => {
  // Cursor 5 minutes ago; 5 already-digested stories plus one new.
  const previous = digest(5 * MIN);
  const freshlyScraped = story(NOW - MIN, NOW - 6 * HOUR); // posted 6h ago, first seen now
  const alreadyDigested = story(NOW - 10 * MIN, NOW - MIN); // posted a minute ago, already sent
  const p = plan([freshlyScraped, alreadyDigested, ...oldStories(4)], previous);

  assert.equal(p.mode, "incremental");
  assert.deepEqual(p.items, [freshlyScraped], "the late-scraped story is sent; the already-digested one is not");
});

test("a story inserted at exactly the cursor counts as new", () => {
  const previous = digest(5 * MIN);
  const boundary = story(NOW - 5 * MIN);
  const p = plan([boundary, ...oldStories(4)], previous);

  assert.equal(p.mode, "incremental");
  assert.deepEqual(p.items, [boundary], "ties go to new: seeing a story twice is cheaper than missing it");
});

test("a cycle that found nothing new is skipped", () => {
  assert.deepEqual(plan(oldStories(6), digest(5 * MIN)), { mode: "skip", reason: "no-new-items" });
});

test("a due rebuild happens even when the cycle added nothing", () => {
  // Otherwise a source that goes quiet right before its rebuild is never
  // rebuilt, and its bullets keep describing stories that aged out.
  const p = plan(oldStories(6), digest(5 * MIN, ["b"], 13 * HOUR));
  assert.equal(p.mode, "full");
  assert.equal(p.reason, "rebuild-due");
});

test("itemCount is the window size, never the incremental batch", () => {
  // The frontend renders it as the user-visible "past 24 hours · N stories".
  const p = plan([...oldStories(37), story(NOW - MIN), story(NOW - 2 * MIN), story(NOW - 3 * MIN)], digest(5 * MIN));
  assert.equal(p.mode, "incremental");
  assert.equal(p.items.length, 3);
  assert.equal(p.itemCount, 40);
});

test("a mostly-new window rebuilds instead of updating incrementally", () => {
  // Seconds apart, so every one of them lands after the 5-minute-old cursor.
  const newOnes = (n) => Array.from({ length: n }, (_, i) => story(NOW - i * 1000));
  // 10 of 20 = exactly the threshold, and it is inclusive.
  assert.equal(plan([...newOnes(10), ...oldStories(10)], digest(5 * MIN)).reason, "mostly-new");
  // 9 of 20 is under it — incremental still saves real work here.
  assert.equal(plan([...newOnes(9), ...oldStories(11)], digest(5 * MIN)).mode, "incremental");
});

test("malformed input yields a plan instead of throwing", () => {
  const cases = [
    { windowItems: null, previous: null, now: NaN, incrementalEnabled: true },
    { windowItems: undefined, previous: undefined, now: 0, incrementalEnabled: true },
    { windowItems: "not an array", previous: "not a digest", now: NOW, incrementalEnabled: true },
    { windowItems: [story(NOW - MIN)], previous: { bullets: null, generatedAt: iso(NOW), fullRebuildAt: iso(NOW) }, now: NOW, incrementalEnabled: true },
    { windowItems: [null], previous: null, now: NOW, incrementalEnabled: true },
    { windowItems: [story(NOW - MIN)], previous: digest(HOUR), now: NOW, incrementalEnabled: "yes" },
  ];
  for (const input of cases) {
    const p = planDigest(input);
    assert.ok(["skip", "full", "incremental"].includes(p.mode), `${JSON.stringify(input)} -> ${JSON.stringify(p)}`);
  }
});

test("a busy source still gets a full rebuild every 12h", () => {
  // The regression that motivated the separate full_rebuild_at marker: on a
  // source that produces items every cycle the digest is rewritten every cycle,
  // so a rule of "rebuild when the stored digest is older than 12h" never fires.
  const CYCLE = 30 * MIN;
  const WINDOW = 24 * HOUR;
  const T0 = Date.parse("2026-11-02T06:00:00Z"); // Mon 08:00 Vilnius
  const CYCLES = 60;

  // A source that has already been running: 40 stories in the trailing 24h
  // before the first simulated cycle.
  const items = Array.from({ length: 40 }, (_, i) => story(T0 - (40 - i) * CYCLE));

  let state = null; // what getDigestState() would return
  const fulls = [];
  const modes = [];

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const now = T0 + cycle * CYCLE;
    const snapshotIso = iso(now); // taken before the read, no await in between

    // Two stories land, then the trailing 24h is re-read.
    items.push(story(now), story(now));
    const since = iso(now - WINDOW);
    const windowItems = items.filter((it) => it.itemTimestamp >= since);

    const p = planDigest({ windowItems, previous: state, now, incrementalEnabled: true });
    modes.push(p.mode);
    if (p.mode === "skip") continue;

    if (p.mode === "full") fulls.push(cycle);
    // Exactly what upsertDigest persists: the cursor always advances, the
    // rebuild marker only on a full rebuild.
    state = {
      bullets: ["b"],
      generatedAt: snapshotIso,
      fullRebuildAt: p.mode === "full" ? snapshotIso : state.fullRebuildAt,
    };
  }

  assert.deepEqual(fulls, [0, 24, 48], "a full rebuild every 12h (24 cycles), starting with the first");
  assert.ok(
    modes.slice(1).every((m) => m === "incremental" || m === "full"),
    `no cycle should be skipped while items keep arriving: ${modes.join(",")}`
  );

  // No two rebuilds are further apart than the interval plus the cycle that
  // noticed — the drift bound the whole design rests on.
  for (let i = 1; i < fulls.length; i++) {
    assert.ok((fulls[i] - fulls[i - 1]) * CYCLE <= DIGEST_FULL_REBUILD_MS + CYCLE);
  }
});

test("a full rebuild that produced nothing stays due on the next cycle", () => {
  // The LLM call failed or returned no bullets, so refreshDigest wrote nothing
  // and neither the cursor nor the marker moved. The rebuild must not be
  // considered done just because it was attempted.
  const previous = digest(13 * HOUR);
  assert.equal(plan([story(NOW - MIN)], previous).reason, "rebuild-due");
  assert.equal(plan([story(NOW + 30 * MIN - MIN)], previous, { now: NOW + 30 * MIN }).reason, "rebuild-due");
});
