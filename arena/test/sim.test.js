import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, runWindow, summarize, scoreAll } from "../sim.js";
import { takerFee } from "../../fees.js";
import { synthTape } from "../synth.js";
import { loadStrategies } from "../strategies/index.js";

const W = (ticks, outcome = 1, extra = {}) => ({ family: "btc15", slug: "w", start: 0, end: 900_000, strike: 100, outcome, ticks, ...extra });

test("quote maps YES book to both sides", () => {
  const q = quote([1, 0.60, 0.62, null, 100]);
  assert.equal(q.up.bid, 0.60); assert.equal(q.up.ask, 0.62);
  assert.ok(Math.abs(q.down.ask - 0.40) < 1e-9); assert.ok(Math.abs(q.down.bid - 0.38) < 1e-9);
});

test("quote rejects crossed or empty books", () => {
  assert.equal(quote([1, 0.7, 0.6, null, 1]), null);
  assert.equal(quote([1, null, null, null, 1]), null);
});

test("orders fill on the NEXT tick at the ask, and pay the taker fee", () => {
  const s = { decide: c => (!c.position ? { buy: "Up" } : null) };
  const r = runWindow(s, W([[1, 0.50, 0.52, null, 1], [2, 0.60, 0.70, null, 1]], 1), { stake: 10 });
  const contracts = 10 / 0.70;
  assert.equal(r.entry, 0.70);
  assert.ok(Math.abs(r.pnl - (contracts - 10 - takerFee(contracts, 0.70))) < 1e-9);
  assert.equal(r.won, true);
});

test("a decision on the last tick never fills", () => {
  const s = { decide: c => (c.msLeft < 500_000 ? { buy: "Up" } : null) };
  assert.equal(runWindow(s, W([[1, 0.5, 0.52, null, 1], [600_000, 0.5, 0.52, null, 1]])), null);
});

test("losing Down bet loses stake plus fee", () => {
  const s = { decide: c => (!c.position ? { buy: "Down" } : null) };
  const r = runWindow(s, W([[1, 0.40, 0.42, null, 1], [2, 0.40, 0.42, null, 1]], 1), { stake: 10 });
  const px = 1 - 0.40, contracts = 10 / px;
  assert.ok(Math.abs(r.pnl - (-(10 + takerFee(contracts, px)))) < 1e-9);
});

test("early sell receives the bid minus fee", () => {
  const s = { decide: c => (!c.position ? { buy: "Up" } : { sell: true, reason: "tp" }) };
  const r = runWindow(s, W([[1, 0.5, 0.5, null, 1], [2, 0.5, 0.5, null, 1], [3, 0.8, 0.82, null, 1]], 0), { stake: 10 });
  const c = 10 / 0.5;
  assert.equal(r.how, "tp");
  assert.ok(Math.abs(r.pnl - ((c * 0.8 - takerFee(c, 0.8)) - (10 + takerFee(c, 0.5)))) < 1e-9);
});

test("unknown outcome is reported as unresolved, not scored", () => {
  const s = { decide: c => (!c.position ? { buy: "Up" } : null) };
  assert.equal(runWindow(s, W([[1, .5, .52, null, 1], [2, .5, .52, null, 1]], null)).unresolved, true);
});

test("strategies never see future ticks", () => {
  let maxSeen = 0;
  const s = { decide: c => { maxSeen = Math.max(maxSeen, c.history.length); assert.equal(c.history.at(-1).t, 900_000 - c.msLeft); return null; } };
  runWindow(s, W([[1, .5, .52, null, 1], [2, .5, .52, null, 1], [3, .5, .52, null, 1]]));
  assert.equal(maxSeen, 3);
});

test("summarize: drawdown and bounds", () => {
  const s = summarize([{ pnl: 2, cost: 10, won: true }, { pnl: -5, cost: 10, won: false }, { pnl: 1, cost: 10, won: true }]);
  assert.equal(s.n, 3); assert.equal(s.maxDD, 5); assert.ok(s.lcb < s.mean && s.mean < s.ucb);
});

test("on synthetic fair markets, the coin-flip control loses money", async () => {
  const { strategies } = await loadStrategies();
  const res = scoreAll(strategies.filter(s => s.name === "control-coinflip"), synthTape({ windows: 300, seed: 3 }));
  const row = res.rows.find(r => r.family === "btc15");
  assert.ok(row.all.n > 250);
  assert.ok(row.all.mean < 0, `control mean ${row.all.mean} should be negative`);
});

test("every strategy file loads", async () => {
  const { strategies, errors } = await loadStrategies();
  assert.deepEqual(errors, []);
  assert.ok(strategies.length >= 5);
});

test("recorder only picks BTC Up/Down windows by real duration", async () => {
  const { familyOf } = await import("../recorder.js");
  const m = (q, mins) => ({ question: q, assetPriceTerms: { windowStart: "2026-10-02T12:00:00Z", windowEnd: new Date(Date.parse("2026-10-02T12:00:00Z") + mins * 60_000).toISOString() } });
  assert.equal(familyOf(m("Bitcoin Up or Down - 15 min", 15)), "btc15");
  assert.equal(familyOf(m("Bitcoin Up or Down - hourly", 60)), "btc60");
  assert.equal(familyOf(m("Bitcoin above 70,000?", 60)), null);
  assert.equal(familyOf(m("Ethereum Up or Down", 15)), null);
  assert.equal(familyOf({ question: "Bitcoin Up or Down" }), null);
});

test("listing sides give a YES bid/ask", async () => {
  const { quoteFromListing } = await import("../recorder.js");
  const m = { marketSides: [{ long: true, price: "0.1300" }, { long: false, price: "0.88" }] };
  assert.deepEqual(quoteFromListing(m), { bid: 0.12, ask: 0.13 });
  assert.deepEqual(quoteFromListing({ marketSides: [{ long: true, price: "0.62" }, { long: false, price: "0.40" }] }), { bid: 0.6, ask: 0.62 });
  assert.deepEqual(quoteFromListing({ marketSides: [{ long: true, price: "0.5" }] }), { bid: null, ask: null });
  assert.deepEqual(quoteFromListing({ marketSides: [{ long: true, price: "0.9" }, { long: false, price: "0.6" }] }), { bid: null, ask: null });
});
