import { test } from "node:test";
import assert from "node:assert/strict";
import * as pt from "../pair-trader.js";
import * as fb from "../fast-book.js";

const cfg = { shares: 10, openMin: 8, cutoffMin: 11, maxPairs: 3, minLeg: 0.25, maxLeg: 0.75, holdAbove: 0.5, offset: 0.06, target: 0.94 };
const START = 0, END = 15 * 60_000;
const book = (bid, ask) => ({ slug: "s", start: START, end: END, bid, ask });   // Up-side book
const min = m => m * 60_000;

test("fast book: Down prices mirror the Up book", () => {
  assert.deepEqual(fb.sides({ bid: 0.47, ask: 0.49 }), { Up: { bid: 0.47, ask: 0.49 }, Down: { bid: 0.51, ask: 0.53 } });
  assert.equal(fb.sides({ bid: null, ask: 0.5 }), null);
});

test("pair: bids rest under the mid, a dip fills one leg, the swing back completes the pair", () => {
  const w = pt.newWindow(book(0.49, 0.51));
  pt.step(w, book(0.49, 0.51), min(1), cfg);
  assert.deepEqual(w.bids.Up, { kind: "open", px: 0.44 }); assert.deepEqual(w.bids.Down, { kind: "open", px: 0.44 });
  // BTC drops: Up's ask comes down to 44¢. Up fills, the Down first-leg bid is cancelled.
  let ev = pt.step(w, book(0.42, 0.44), min(2), cfg);
  assert.match(ev[0], /first leg: Up 10 @ 44¢/);
  assert.equal(w.open.side, "Up");
  assert.equal(w.bids.Down.kind, "close"); assert.equal(w.bids.Down.px, 0.50, "94¢ − 44¢");
  // BTC bounces: Up bid 50¢ → Down ask 50¢. Pair done at 94¢.
  ev = pt.step(w, book(0.50, 0.52), min(4), cfg);
  assert.match(ev[0], /pair done: Up 44¢ \+ Down 50¢ = 94¢/);
  assert.equal(w.pairs.length, 1); assert.equal(w.open, null);
  assert.ok(w.pairs[0].pnl > 0.6 && w.pairs[0].pnl < 0.7, `6¢ x 10 plus small rebates (${w.pairs[0].pnl})`);
  // Back to resting first-leg bids.
  assert.equal(w.bids.Up.kind, "open");
});

test("pair: no fill from bids placed on the same tick (one-tick delay)", () => {
  const w = pt.newWindow(book(0.49, 0.51));
  assert.deepEqual(pt.step(w, book(0.42, 0.44), min(1), cfg), [], "bids didn't exist before this tick");
});

test("pair: unpaired leg at the cutoff is sold if losing, held if winning", () => {
  const lose = pt.newWindow(book(0.49, 0.51));
  pt.step(lose, book(0.49, 0.51), min(1), cfg);
  pt.step(lose, book(0.42, 0.44), min(2), cfg);              // Up @ 44¢
  const ev = pt.step(lose, book(0.30, 0.32), min(11), cfg);   // Up kept falling
  assert.match(ev.at(-1), /sold at 30¢/);
  assert.ok(lose.sold[0].pnl < -1.4, "lost ~14¢ x 10 plus the fee");
  assert.equal(lose.bids.Up, null, "no new legs after the open period");

  const win = pt.newWindow(book(0.49, 0.51));
  pt.step(win, book(0.49, 0.51), min(1), cfg);
  pt.step(win, book(0.42, 0.44), min(2), cfg);
  pt.step(win, book(0.70, 0.72), min(11), cfg);               // BTC swung back up: Down ask 30¢ ≤ the 50¢ bid
  assert.equal(win.pairs.length, 1, "the fill comes before the cutoff decision: a pair, not a hold");
});

test("pair: losing leg sold at the cutoff, winning leg held and settled", () => {
  const w = pt.newWindow(book(0.49, 0.51));
  pt.step(w, book(0.49, 0.51), min(1), cfg);
  pt.step(w, book(0.56, 0.58), min(2), cfg);                  // Down ask 44¢: Down @ 44¢; completion = Up bid 50¢
  assert.equal(w.open.side, "Down");
  pt.step(w, book(0.53, 0.55), min(11), cfg);                 // Up ask 55¢ > 50¢: no pair; Down bid 45¢ < 50¢: sold
  assert.equal(w.sold.length, 1);
  const w2 = pt.newWindow(book(0.49, 0.51));
  pt.step(w2, book(0.49, 0.51), min(1), cfg);
  pt.step(w2, book(0.56, 0.58), min(2), cfg);                 // Down @ 44¢
  pt.step(w2, book(0.40, 0.52), min(11), cfg);                // Up ask 52¢ > 50¢; Down bid 48¢ < 50¢ → sold
  assert.equal(w2.sold.length, 1);
  const w4 = pt.newWindow(book(0.49, 0.51));
  pt.step(w4, book(0.49, 0.51), min(1), { ...cfg, holdAbove: 0.45 });
  pt.step(w4, book(0.56, 0.58), min(2), { ...cfg, holdAbove: 0.45 });
  pt.step(w4, book(0.44, 0.51), min(11), { ...cfg, holdAbove: 0.45 });   // Down bid 49¢ ≥ 45¢: held
  assert.equal(w4.held.length, 1);
  const won = pt.settleWindow(w4, 0), lost = pt.settleWindow({ ...w4, held: [...w4.held] }, 1);
  assert.ok(won.pnl > 5.5, `Down won: 10 x (1 − 0.44) (${won.pnl})`);
  assert.ok(lost.pnl < -4.3, `Down lost: −4.40 (${lost.pnl})`);
  assert.equal(pt.settleWindow({ ...w4, held: [...w4.held] }, null).unpairedPnl, 0, "unknown result counts nothing");
});

test("pair: a completion bid above the ask fills as a taker at the ask", () => {
  const w = pt.newWindow(book(0.49, 0.51));
  pt.step(w, book(0.49, 0.51), min(1), cfg);
  pt.step(w, book(0.42, 0.44), min(2), cfg);                  // Up @ 44¢ — completion bid on Down 50¢; Down ask now 58¢
  w.bids.Down = null;
  pt.step(w, book(0.53, 0.55), min(3), cfg);                  // re-placed: Down ask 47¢ ≤ 50¢ → crossing
  assert.equal(w.bids.Down.crossAsk, 0.47);
  pt.step(w, book(0.53, 0.55), min(3) + 1000, cfg);
  assert.equal(w.pairs[0].down, 0.47, "paid the ask, not our bid");
});

test("pair: no new legs outside the price range or after the open period", () => {
  const w = pt.newWindow(book(0.85, 0.87));
  pt.step(w, book(0.85, 0.87), min(1), cfg);
  assert.equal(w.bids.Up, null, "Up mid 86¢ is over 75¢"); assert.equal(w.bids.Down, null, "Down mid 14¢ under 25¢");
  const late = pt.newWindow(book(0.49, 0.51));
  pt.step(late, book(0.49, 0.51), min(9), cfg);
  assert.equal(late.bids.Up, null);
});

test("pair totals", () => {
  const t = pt.totals([{ legs: 2, pairs: [{ up: 0.44, down: 0.5, pnl: 0.6 }], lockedPnl: 0.6, unpairedPnl: -1, pnl: -0.4 }, { legs: 1, pairs: [], lockedPnl: 0, unpairedPnl: 2, pnl: 2 }]);
  assert.equal(t.completion, 0.333); assert.equal(t.pnl, 1.6); assert.equal(t.avgEdge, 0.06);
});

test("fast book tick: reads the current window's book, backs off on 429", async () => {
  fb._reset();
  const end = Math.ceil(Date.now() / 900_000) * 900_000;
  let calls = 0, fail = null;
  fb._set({ rec: { liveQuote: () => ({ slug: "w1", start: end - 900_000, end }) },
    pmMod: { getBBO: async () => { calls++; if (fail) throw fail; return { bid: 0.47, ask: 0.49 }; } } });
  const got = [];
  const off = fb.onTick(b => got.push(b));
  await fb._tick();
  assert.equal(got.length, 1); assert.equal(got[0].slug, "w1");
  assert.ok(fb.fastQuote("w1")); assert.equal(fb.fastQuote("other"), null);
  await fb._tick();
  assert.equal(calls, 1, "waits its gap between reads");
  fail = Object.assign(new Error("Request failed with status code 429"), { response: { status: 429 } });
  fb._ready(); await fb._tick();
  assert.equal(fb.fastBookStatus().rateLimited, 1);
  assert.equal(fb.currentGap(), 2000, "the gap doubles (at least 2s) after a 429");
  await fb._tick();
  assert.equal(calls, 2, "paused: no request straight after a 429");
  off(); fb._reset();
});
