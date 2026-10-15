import { test } from "node:test";
import assert from "node:assert/strict";
import * as sc from "../sports-scout.js";
import * as ss from "../sports-shadow.js";

const ev = (slug, markets, endDate = new Date(Date.now() - 86400_000).toISOString()) => ({ slug, endDate, markets });
const mkt = (id, q, outcomes, prices, volumeNum = 50000) => ({ conditionId: id, question: q, outcomes: JSON.stringify(outcomes), outcomePrices: JSON.stringify(prices), volumeNum });

test("settled main markets only: no spreads/totals, no unsettled", () => {
  const e = ev("nba-lal-bos-2026-10-13", [
    mkt("ml", "Lakers vs. Celtics", ["Lakers", "Celtics"], ["0", "1"]),
    mkt("sp", "Spread: Lakers (-4.5)", ["Lakers", "Celtics"], ["1", "0"]),
    mkt("ou", "Lakers vs. Celtics: O/U 221.5", ["Over", "Under"], ["1", "0"]),
    mkt("open", "Lakers vs. Celtics (live)", ["Lakers", "Celtics"], ["0.6", "0.4"]),
  ]);
  const m = sc.settledMarkets(e);
  assert.deepEqual(m.map(x => x.conditionId), ["ml"]); assert.equal(m[0].winner, 1); assert.equal(m[0].league, "nba");
  assert.deepEqual(sc.settledMarkets(ev("presidential-election-2028", [mkt("x", "Who wins?", ["A", "B"], ["1", "0"])])), [], "not a sports slug");
  assert.deepEqual(sc.settledMarkets(ev("atp-a-b-2026-10-13", [mkt("tiny", "A vs B", ["A", "B"], ["1", "0"], 300)])), [], "too little volume to judge anyone");
});

test("per-game wallet result: buys, sells, $1 per winning share", () => {
  const mk = { outcomes: ["Lakers", "Celtics"], winner: 1 };
  const r = sc.scoreMarket([
    { proxyWallet: "0xA", side: "BUY", size: 100, price: 0.4, outcomeIndex: 1 },     // $40 on the winner → $100
    { proxyWallet: "0xB", side: "BUY", size: 50, price: 0.6, outcomeIndex: 0 },      // $30 on the loser
    { proxyWallet: "0xC", side: "BUY", size: 100, price: 0.5, outcome: "Celtics" },  // $50, sells half at 70¢ → $35 + 50 shares win
    { proxyWallet: "0xC", side: "SELL", size: 50, price: 0.7, outcome: "Celtics" },
    { proxyWallet: "0xD", side: "BUY", size: 1, price: 0.5, outcomeIndex: 1 },       // dust
  ], mk);
  assert.deepEqual(r["0xa"], { cost: 40, pnl: 60, name: null });
  assert.equal(r["0xb"].pnl, -30);
  assert.equal(r["0xc"].pnl, 35);
  assert.equal(r["0xd"], undefined);
});

test("records, sharp picks and the per-league real-money gate", () => {
  const res = [];
  for (let i = 0; i < 10; i++) res.push({ wallet: "0xsharp", league: i < 6 ? "nba" : "nfl", cost: 100, pnl: i % 4 ? 30 : -100 });   // 7 of 10 won
  for (let i = 0; i < 10; i++) res.push({ wallet: "0xfish", league: "nba", cost: 100, pnl: i % 2 ? 20 : -100 });
  for (let i = 0; i < 3; i++) res.push({ wallet: "0xnew", league: "nba", cost: 100, pnl: 90 });
  const recs = sc.records(res);
  const sharp = recs.find(r => r.wallet === "0xsharp");
  assert.equal(sharp.games, 10); assert.equal(sharp.wins, 7);
  // 7 wins x $30 − 3 losses x $100 = −$90: not sharp despite 70% wins.
  assert.equal(sharp.pnl, -90); assert.equal(sharp.sharp, false);
  const res2 = res.map(r => r.wallet === "0xsharp" && r.pnl < 0 ? { ...r, pnl: -20 } : r);   // smaller losses: +$150
  const recs2 = sc.records(res2);
  assert.equal(recs2.find(r => r.wallet === "0xsharp").sharp, true);
  assert.equal(recs2.find(r => r.wallet === "0xfish").sharp, false);
  assert.equal(recs2.find(r => r.wallet === "0xnew").sharp, false, "3 games is too few");
  assert.deepEqual(sc.pickSharp(recs2).map(r => r.wallet), ["0xsharp"]);
});

test("a scout run reads settled games, scores wallets and hands the sharp ones to SPORTS SHADOW", async () => {
  sc._reset();
  const games = Array.from({ length: 10 }, (_, i) => ev(`nhl-a${i}-b${i}-2026-10-0${(i % 9) + 1}`, [mkt("g" + i, `Game ${i}`, ["A", "B"], ["1", "0"])]));
  sc._set({ fetchFn: async url => ({ ok: true, json: async () => {
    if (/gamma/.test(url)) return /offset=0/.test(url) ? games : [];
    const id = /market=(g\d+)/.exec(url)[1], i = Number(id.slice(1));
    return /offset=0/.test(url) ? [
      { proxyWallet: "0xpro", side: "BUY", size: 100, price: 0.5, outcomeIndex: i < 8 ? 0 : 1 },   // wins 8 of 10
      { proxyWallet: "0xfish", side: "BUY", size: 100, price: 0.5, outcomeIndex: 1 },              // always the loser
    ] : [];
  } }) });
  let handed = null;
  sc._set({ onSharpFn: l => { handed = l; } });
  const run = await sc.runScout();
  assert.equal(run.markets, 10);
  assert.deepEqual(sc.sharpWallets(), ["0xpro"]);
  assert.deepEqual(handed, ["0xpro"]);
  assert.equal(sc.scoutProven("0xpro", "nhl").ok, true);
  assert.match(sc.scoutProven("0xpro", "nba").why, /only 0 settled nba/);
  assert.match(sc.scoutProven("0xfish", "nhl").why, /not rated sharp/);
  // Re-running skips games already scored.
  assert.equal((await sc.runScout()).markets, 0);
});

test("SPORTS SHADOW follows scouted wallets, skipping their earlier bets", async () => {
  ss._reset();
  ss.setScoutedWallets(["0x1111111111111111111111111111111111111111"]);
  assert.deepEqual(ss.sportsShadowStatus().scouted, ["0x1111111111111111111111111111111111111111"]);
  let rows = [{ proxyWallet: "0x1111111111111111111111111111111111111111", side: "BUY", price: 0.4, size: 50, timestamp: 1, transactionHash: "0xold", eventSlug: "nhl-a-b-2026-10-20", slug: "nhl-a-b-2026-10-20", title: "A vs B", outcome: "A" }];
  ss._set({ fetchFn: async () => ({ ok: true, json: async () => rows }), pmMod: { cachedSportsMoneylines: () => ({ at: 1, markets: [] }), getBBO: async () => null, getSettlement: async () => null } });
  await ss._poll(Date.now());
  assert.equal(ss._state.misses.length, 0, "first look at a wallet copies nothing");
  rows = [...rows, { ...rows[0], transactionHash: "0xnew" }];
  await ss._poll(Date.now());
  assert.equal(ss._state.misses.length, 0, "the new bet waits: no US list here yet");
  assert.equal(ss._state.seen.filter(id => /0xnew/.test(id)).length, 0, "and stays unseen so it's tried again");
});

test("the scout only rates leagues Polymarket US lists", () => {
  sc.setUsLeagues(["nba"]);
  try {
    assert.equal(sc.settledMarkets(ev("nba-a-b-2026-10-13", [mkt("x", "A vs B", ["A", "B"], ["1", "0"])])).length, 1);
    assert.equal(sc.settledMarkets(ev("uel-a-b-2026-10-13", [mkt("y", "A vs B", ["A", "B"], ["1", "0"])])).length, 0);
  } finally { sc.setUsLeagues(sc.US_LEAGUES_DEFAULT); }
});

test("a wallet sharp across 20+ games may bet a league it's new to, unless losing there", () => {
  const res = [];
  for (let i = 0; i < 24; i++) res.push({ wallet: "0xbig", league: "mlb", cost: 100, pnl: i % 3 ? 40 : -30 });
  res.push({ wallet: "0xbig", league: "nfl", cost: 100, pnl: -50 });
  for (let i = 0; i < 10; i++) res.push({ wallet: "0xsmall", league: "mlb", cost: 100, pnl: 60 });
  sc._reset(); sc._setRecords(sc.records(res));
  assert.equal(sc.scoutProven("0xbig", "nhl").ok, true, "no NHL games yet: the overall record counts");
  assert.equal(sc.scoutProven("0xbig", "nfl").ok, false, "its one NFL game lost");
  assert.match(sc.scoutProven("0xsmall", "nhl").why, /20\+ profitable games overall/);
  assert.equal(sc.scoutProven("0xsmall", "mlb").ok, true);
});
