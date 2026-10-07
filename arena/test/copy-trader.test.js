import { test } from "node:test";
import assert from "node:assert/strict";
import * as ct from "../copy-trader.js";

const cfg = { ...ct.CFG, minWindows: 20, minWinRate: 0.55, minRoi: 0.05, maxBothSides: 0.3, maxBestShare: 0.5, activeMs: 86400_000, maxPrice: 0.9, maxSlippage: 0.1, minMsLeft: 30_000 };

test("global slugs: 15-minute by start time, hourly by ET hour", () => {
  assert.deepEqual(ct.globalSlugs("btc15", Date.UTC(2026, 9, 7, 15, 0)), ["btc-updown-15m-1791385200"]);
  assert.equal(ct.globalSlugs("btc60", Date.UTC(2026, 9, 7, 19, 0))[0], "bitcoin-up-or-down-october-7-3pm-et");
  assert.equal(ct.globalSlugs("btc60", Date.UTC(2026, 9, 7, 4, 0))[0], "bitcoin-up-or-down-october-7-12am-et");
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

test("decideCopy: prices Down off the Up bid, and skips bad US prices", () => {
  const now = 1_000_000;
  const us = { slug: "x", end: now + 120_000, bid: 0.40, ask: 0.42 };
  const up = { outcome: "Up", price: 0.40 }, down = { outcome: "Down", price: 0.55 };
  assert.deepEqual(ct.decideCopy({ trade: up, us, holding: false, now, cfg }), { copy: true, price: 0.42 });
  assert.deepEqual(ct.decideCopy({ trade: down, us, holding: false, now, cfg }), { copy: true, price: 0.6 });
  assert.match(ct.decideCopy({ trade: up, us: null, holding: false, now, cfg }).why, /no matching/);
  assert.match(ct.decideCopy({ trade: up, us: { ...us, end: now + 10_000 }, holding: false, now, cfg }).why, /close/);
  assert.match(ct.decideCopy({ trade: up, us, holding: true, now, cfg }).why, /already/);
  assert.match(ct.decideCopy({ trade: { outcome: "Up", price: 0.2 }, us, holding: false, now, cfg }).why, /worse than theirs/);
  assert.match(ct.decideCopy({ trade: { outcome: "Up", price: 0.93 }, us: { ...us, bid: 0.93, ask: 0.95 }, holding: false, now, cfg }).why, /cap/);
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
