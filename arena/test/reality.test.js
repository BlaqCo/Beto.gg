import { test } from "node:test";
import assert from "node:assert/strict";
import { compareTrades, summarizeGap } from "../reality.js";

const T0 = Date.parse("2026-10-03T05:00:00Z");
// A 15-minute window: YES 0.60/0.62 throughout, resolves Up.
const win = { family: "btc15", slug: "w1", start: T0, end: T0 + 900_000, strike: 1, outcome: 1,
  ticks: Array.from({ length: 180 }, (_, i) => [T0 + i * 5000, 0.60, 0.62, null, 1]) };

test("a bot trade is replayed on the same window, side and timing", () => {
  const trade = { slug: "w1", league: "BTC15", side: "Up", entry: 0.62, size: 20, pnl: 12, isPaper: true,
                  reason: "expiry", at: new Date(T0 + 700_000).toISOString(), settledAt: new Date(T0 + 900_000).toISOString() };
  const { rows, skipped } = compareTrades([trade, { ...trade, slug: "not-on-tape" }], [win]);
  assert.equal(skipped, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].arenaEntry, 0.62);
  assert.equal(rows[0].botPnl, 6);                       // $12 on $20 -> $6 per $10
  assert.ok(rows[0].arenaPnl > 5 && rows[0].arenaPnl < 6.2, String(rows[0].arenaPnl));
});

test("an early sell is copied: the arena sells at the bid when the bot did", () => {
  const trade = { slug: "w1", league: "BTC15", side: "Up", entry: 0.62, size: 10, pnl: -0.3, reason: "take_profit",
                  at: new Date(T0 + 100_000).toISOString(), settledAt: new Date(T0 + 400_000).toISOString() };
  const { rows } = compareTrades([trade], [win]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].arenaPnl < 0, "bought at the ask, sold at the bid: a small loss");
});

test("the verdict needs enough trades and flags a real gap", () => {
  const mk = gaps => gaps.map(g => ({ gap: g, botEntry: 0.6, arenaEntry: 0.6 }));
  assert.equal(summarizeGap([]).label, "no data");
  assert.equal(summarizeGap(mk([-1, -1])).label, "too early");
  assert.equal(summarizeGap(mk(Array.from({ length: 30 }, (_, i) => -1 + (i % 3) * 0.1))).label, "arena too optimistic");
  assert.equal(summarizeGap(mk(Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.1 : -0.1)))).label, "matches");
  assert.equal(summarizeGap(mk(Array.from({ length: 30 }, (_, i) => 0.8 + (i % 3) * 0.1))).label, "arena too strict");
});
