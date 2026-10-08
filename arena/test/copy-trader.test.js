import { test } from "node:test";
import assert from "node:assert/strict";
import * as ct from "../copy-trader.js";

const cfg = { ...ct.CFG, minWindows: 20, minWinRate: 0.55, minRoi: 0.05, maxBothSides: 0.3, maxBestShare: 0.5, activeMs: 86400_000, entryWindowMs: 180_000, minPrice: 0.8, maxPrice: 0.95, minMsLeft: 30_000 };

test("global slugs: 15-minute by start time, hourly by ET hour", () => {
  assert.deepEqual(ct.globalSlugs("btc15", Date.UTC(2026, 9, 7, 15, 0)), ["btc-updown-15m-1791385200"]);
  assert.deepEqual(ct.globalSlugs("btc60", Date.UTC(2026, 9, 7, 19, 0)),
    ["btc-updown-1h-1791399600", "bitcoin-up-or-down-october-7-2026-3pm-et", "bitcoin-up-or-down-october-7-3pm-et"]);
  assert.equal(ct.globalSlugs("btc60", Date.UTC(2026, 9, 7, 4, 0))[2], "bitcoin-up-or-down-october-7-12am-et");
});

test("marketMatchesWindow: rejects last year's market behind a slug with no year", () => {
  const end = Date.UTC(2026, 9, 7, 8, 0);
  assert.equal(ct.marketMatchesWindow("btc60", {}, { endDate: "2026-10-07T08:00:00Z" }, end), true);
  assert.equal(ct.marketMatchesWindow("btc60", {}, { endDate: "2025-10-07T08:00:00Z" }, end), false);
  assert.equal(ct.marketMatchesWindow("btc60", { endDate: "2025-10-07T08:00:00Z" }, {}, end), false);
  assert.equal(ct.marketMatchesWindow("btc60", {}, {}, end), false);
  assert.equal(ct.marketMatchesWindow("btc15", {}, {}, end), true);
});

test("scoring a window: winners get $1 a share, sells count, sell-only wallets are skipped", () => {
  const T = (wallet, side, outcome, size, price) => ({ wallet, side, outcome, size, price, name: null });
  const r = ct.scoreTrades([
    T("a", "BUY", "Up", 100, 0.6),                              // won: 100 - 60 = +40
    T("b", "BUY", "Down", 50, 0.4),                             // lost: -20
    T("c", "BUY", "Up", 10, 0.5), T("c", "BUY", "Down", 10, 0.5),// both sides: 10 - 10 = 0
    T("d", "BUY", "Up", 20, 0.5), T("d", "SELL", "Up", 20, 0.7),// flipped out early: +4
    T("e", "SELL", "Down", 30, 0.3),                            // sell only: no cost seen, skipped
  ], 1);
  const by = Object.fromEntries(r.map(x => [x.wallet, x]));
  assert.equal(Math.round(by.a.pnl), 40);
  assert.equal(Math.round(by.b.pnl), -20);
  assert.equal(Math.round(by.c.pnl), 0); assert.equal(by.c.both, true);
  assert.equal(Math.round(by.d.pnl * 10) / 10, 4);
  assert.equal(by.e, undefined);
});

test("judge: needs a long, recent, profitable record and isn't a two-sided bot", () => {
  const now = Date.now();
  const good = { windows: 40, wins: 26, pnl: 300, cost: 2000, both: 2, best: 60, lastSeen: now - 3600_000 };
  assert.equal(ct.judge(good, now, cfg).smart, true);
  assert.match(ct.judge({ ...good, windows: 5 }, now, cfg).why, /5\/20/);
  assert.match(ct.judge({ ...good, lastSeen: now - 3 * 86400_000 }, now, cfg).why, /not active/);
  assert.match(ct.judge({ ...good, both: 30 }, now, cfg).why, /both sides/);
  assert.match(ct.judge({ ...good, pnl: 50 }, now, cfg).why, /ROI/);
  assert.match(ct.judge({ ...good, wins: 18 }, now, cfg).why, /win rate/);
  assert.match(ct.judge({ ...good, best: 250 }, now, cfg).why, /one window/);
});

test("decideEntry: last 3 minutes, smart-money side, 80-95¢ on US only", () => {
  const now = 1_000_000, end = now + 150_000;
  const us = { end, bid: 0.84, ask: 0.86 };       // Up 86¢ to buy, Down 16¢
  const up = { Up: 120, Down: 30 }, down = { Up: 10, Down: 90 };
  assert.deepEqual(ct.decideEntry({ smartFlow: up, us, holding: false, now, cfg }), { enter: true, side: "Up", price: 0.86 });
  assert.equal(ct.decideEntry({ smartFlow: up, us: { ...us, end: now + 600_000 }, holding: false, now, cfg }).wait, true, "too early just waits");
  assert.match(ct.decideEntry({ smartFlow: up, us: { ...us, end: now + 10_000 }, holding: false, now, cfg }).why, /close/);
  assert.match(ct.decideEntry({ smartFlow: down, us, holding: false, now, cfg }).why, /under the 80¢ minimum/, "Down at 16¢ is too cheap");
  assert.match(ct.decideEntry({ smartFlow: { Up: 0, Down: 0 }, us, holding: false, now, cfg }).why, /no smart-wallet side/);
  assert.match(ct.decideEntry({ smartFlow: { Up: 50, Down: 50 }, us, holding: false, now, cfg }).why, /no smart-wallet side/, "a tie isn't a side");
  assert.match(ct.decideEntry({ smartFlow: up, us: { ...us, bid: 0.95, ask: 0.97 }, holding: false, now, cfg }).why, /over the 95¢ cap/);
  assert.match(ct.decideEntry({ smartFlow: up, us: { ...us, bid: 0, ask: 0 }, holding: false, now, cfg }).why, /no valid US price/, "a 0¢ quote is refused");
  assert.match(ct.decideEntry({ smartFlow: up, us, holding: true, now, cfg }).why, /already holding/);
  assert.deepEqual(ct.decideEntry({ smartFlow: down, us: { end, bid: 0.10, ask: 0.12 }, holding: false, now, cfg }), { enter: true, side: "Down", price: 0.9 });
});

test("normTrade: reads the public trade shape, seconds or ms", () => {
  const t = ct.normTrade({ proxyWallet: "0xABC", side: "BUY", outcomeIndex: 1, size: "12", price: "0.3", timestamp: 1791385200, transactionHash: "0x1", pseudonym: "Fox" }, ["Up", "Down"]);
  assert.equal(t.wallet, "0xabc"); assert.equal(t.outcome, "Down"); assert.equal(t.size, 12); assert.equal(t.t, 1791385200000); assert.equal(t.name, "Fox");
});

test("newTrades: reads only unseen trades whether the feed is newest-first or oldest-first", async () => {
  for (const order of ["desc", "asc"]) {
    let all = Array.from({ length: 1200 }, (_, i) => ({ proxyWallet: "0x" + (i % 7), side: "BUY", outcome: "Up", size: 1, price: 0.5, timestamp: 1000 + i, transactionHash: "0x" + i }));
    ct._setFetch(async url => {
      const u = new URL(url), lim = +u.searchParams.get("limit"), off = +u.searchParams.get("offset");
      const rows = order === "desc" ? [...all].reverse() : all;
      return { ok: true, json: async () => rows.slice(off, off + lim) };
    });
    const cur = { market: { conditionId: "c", outcomes: ["Up", "Down"] }, seen: new Set(), order: null, nextOffset: 0 };
    const first = await ct.newTrades(cur);
    assert.equal(first.length, 1200, `${order}: first read gets everything`);
    for (const t of first) cur.seen.add(t.id);
    all = all.concat(Array.from({ length: 30 }, (_, i) => ({ proxyWallet: "0xnew", side: "BUY", outcome: "Down", size: 2, price: 0.4, timestamp: 5000 + i, transactionHash: "0xn" + i })));
    const next = await ct.newTrades(cur);
    assert.equal(next.length, 30, `${order}: second read gets only the 30 new trades`);
    assert.equal(cur.order, order);
  }
  ct._setFetch((...a) => fetch(...a));
});

test("leaderboardRows: one row per family in arena units, too early under 30 copies", () => {
  ct._reset();
  const rows = ct.leaderboardRows();
  assert.deepEqual(rows.map(r => [r.name, r.family, r.n, r.verdict]), [["shadow-copy", "btc15", 0, "too early"], ["shadow-copy", "btc60", 0, "too early"]]);
  ct.settlePaper({ slug: "none", outcome: 1 });   // nothing open: no change
  assert.equal(ct.leaderboardRows()[0].n, 0);
});

test("position management: DCA once in the band, stop at 22¢, numbers match the plan", () => {
  const cfg = { ...ct.CFG, stake: 10, dcaUsd: 20, dcaLow: 0.58, dcaHigh: 0.66, stopPrice: 0.22, minMsLeft: 30_000 };
  const now = 1_000_000;
  const pos = { side: "Up", end: now + 300_000, price: 0.82, contracts: 10 / 0.82, cost: 10 + 0.1081, staked: 10, avg: 0.82, dca: null };
  assert.equal(ct.decideManage({ pos, us: { bid: 0.75, ask: 0.77 }, now, cfg }), null, "no action above the band");
  assert.equal(ct.decideManage({ pos, us: { bid: 0.50, ask: 0.52 }, now, cfg }), null, "a gap past the band doesn't add");
  const d = ct.decideManage({ pos, us: { bid: 0.61, ask: 0.62 }, now, cfg });
  assert.deepEqual(d, { dca: true, price: 0.62, bid: 0.61 });
  ct.applyManage(pos, d, now, cfg);
  assert.equal(pos.staked, 30);
  assert.equal(Math.round(pos.contracts * 100) / 100, 44.45);
  assert.equal(Math.round(pos.avg * 1000) / 10, 67.5);
  assert.equal(ct.decideManage({ pos, us: { bid: 0.60, ask: 0.61 }, now, cfg }), null, "DCA happens once");
  const st = ct.decideManage({ pos, us: { bid: 0.22, ask: 0.24 }, now, cfg });
  assert.equal(st.stop, true);
  const closed = ct.applyManage(pos, st, now, cfg);
  assert.equal(closed.pnl, -21.24);
  assert.equal(closed.exit.reason, "stop");
  // Down side reads the complement of the Up quote.
  const down = { side: "Down", end: now + 300_000, dca: null };
  assert.deepEqual(ct.decideManage({ pos: down, us: { bid: 0.38, ask: 0.40 }, now, cfg }), { dca: true, price: 0.62, bid: 0.6 });
  assert.equal(ct.decideManage({ pos: down, us: { bid: 0.76, ask: 0.78 }, now, cfg }).stop, true);
});

test("default rule: last 4 minutes, 72-95¢, DCA $20 at 53-63¢, stop 22¢", () => {
  const c = ct.CFG;
  assert.equal(c.entryWindowMs, 240_000); assert.equal(c.minPrice, 0.72); assert.equal(c.maxPrice, 0.95);
  assert.equal(c.dcaLow, 0.53); assert.equal(c.dcaHigh, 0.63); assert.equal(c.dcaUsd, 20); assert.equal(c.stopPrice, 0.22);
  const now = 1_000_000, up = { Up: 100, Down: 0 };
  assert.deepEqual(ct.decideEntry({ smartFlow: up, us: { end: now + 230_000, bid: 0.72, ask: 0.74 }, holding: false, now, cfg: c }), { enter: true, side: "Up", price: 0.74 }, "3:50 left at 74¢ enters");
  assert.equal(ct.decideEntry({ smartFlow: up, us: { end: now + 250_000, bid: 0.72, ask: 0.74 }, holding: false, now, cfg: c }).wait, true, "4:10 left waits");
  assert.match(ct.decideEntry({ smartFlow: up, us: { end: now + 200_000, bid: 0.69, ask: 0.71 }, holding: false, now, cfg: c }).why, /under the 72¢ minimum/);
});
