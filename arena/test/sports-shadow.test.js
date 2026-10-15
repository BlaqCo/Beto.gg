import { test } from "node:test";
import assert from "node:assert/strict";
import * as ss from "../sports-shadow.js";
import * as wr from "../wallet-report.js";

const W = "0x424eb20fcd25113e3b98f42522a54580350b263b";
const trade = (o = {}) => ({ proxyWallet: W, side: "BUY", price: 0.42, size: 100, timestamp: 1_790_000_000, transactionHash: "0xabc",
  eventSlug: "mlb-cle-tb-2026-10-13", slug: "mlb-cle-tb-2026-10-13", title: "Guardians vs. Rays", outcome: "Guardians", name: "sharp", ...o });
const US = [
  { slug: "aec-mlb-cle-tb-2026-10-13", question: "Will the Cleveland Guardians win against the Tampa Bay Rays?", gameStartIso: "2099-01-01T00:00:00Z", ask: 0.45, bid: 0.43 },
  { slug: "asc-mlb-cle-tb-2026-10-13-pos-4pt5", question: "Will the Cleveland Guardians cover 4.5 vs the Tampa Bay Rays?", gameStartIso: "2099-01-01T00:00:00Z", ask: 0.8, bid: 0.78 },
];

test("only sports BUYs become signals", () => {
  assert.equal(ss.toSignal(trade()).league, "mlb");
  assert.equal(ss.toSignal(trade({ side: "SELL" })), null);
  assert.equal(ss.toSignal(trade({ eventSlug: "btc-updown-15m-1790000000", slug: "btc-updown-15m-1790000000" })), null);
  assert.equal(ss.toSignal(trade({ price: 0 })), null);
});

test("team names match loosely, the US question gives the YES team", () => {
  assert.equal(ss.yesTeamOf("Will the Cleveland Guardians win against the Tampa Bay Rays?"), "cleveland guardians");
  assert.ok(ss.sameTeam("cleveland guardians", "Guardians"));
  assert.ok(!ss.sameTeam("cleveland guardians", "Rays"));
});

test("matching: backed team → YES, the other team in a two-team game → NO", () => {
  const g = ss.matchUs(ss.toSignal(trade()), US);
  assert.equal(g.market.slug, "aec-mlb-cle-tb-2026-10-13"); assert.equal(g.buy, "YES");
  const r = ss.matchUs(ss.toSignal(trade({ outcome: "Rays" })), US);
  assert.equal(r.buy, "NO", "the US market names the Guardians, so backing the Rays is NO");
  assert.match(ss.matchUs(ss.toSignal(trade({ eventSlug: "nba-lal-bos-2026-10-13", slug: "nba-lal-bos-2026-10-13" })), US).why, /no US market/);
});

test("matching: soccer Yes/No markets", () => {
  const us = [
    { slug: "aec-epl-ars-che-2026-10-18-ars", question: "Will Arsenal win against Chelsea?", gameStartIso: "2099-01-01T00:00:00Z" },
    { slug: "aec-epl-ars-che-2026-10-18-che", question: "Will Chelsea win against Arsenal?", gameStartIso: "2099-01-01T00:00:00Z" },
  ];
  const yes = ss.matchUs(ss.toSignal(trade({ eventSlug: "epl-ars-che-2026-10-18", slug: "epl-ars-che-2026-10-18-che", title: "Will Chelsea win on 2026-10-18?", outcome: "Yes" })), us);
  assert.equal(yes.market.slug, "aec-epl-ars-che-2026-10-18-che"); assert.equal(yes.buy, "YES");
  const no = ss.matchUs(ss.toSignal(trade({ eventSlug: "epl-ars-che-2026-10-18", slug: "epl-ars-che-2026-10-18-che", title: "Will Chelsea win on 2026-10-18?", outcome: "No" })), us);
  assert.match(no.why, /can draw/, "No in a game that can draw isn't mapped");
});

test("poll: skips history on first run, copies new bets at the book price, settles them", async () => {
  ss._reset();
  ss._state.wallets = [W];
  let rows = [trade({ transactionHash: "0xold" })];
  let settlement = null;
  ss._set({ fetchFn: async () => ({ ok: true, json: async () => rows }),
    pmMod: { cachedSportsMoneylines: () => ({ at: 1, markets: US }), getBBO: async () => ({ bid: 0.41, ask: 0.44 }), getSettlement: async () => settlement } });
  await ss._poll(1000);
  assert.equal(ss._state.open.length, 0, "first run only remembers");
  rows = [trade({ transactionHash: "0xold" }), trade({ transactionHash: "0xnew" }), trade({ transactionHash: "0xnew2", price: 0.45 })];
  await ss._poll(2000);
  assert.equal(ss._state.open.length, 1, "one bet per wallet per market");
  const b = ss._state.open[0];
  assert.equal(b.buy, "YES"); assert.equal(b.px, 0.44, "paid the book's ask");
  // Settles after the game: Guardians won.
  settlement = 1;
  await ss._settle(b.start + 4 * 3600_000);
  assert.equal(ss._state.closed[0].won, true);
  assert.ok(ss._state.closed[0].pnl > 12, "10/0.44 − 10 − fee");
  const st = ss.sportsShadowStatus();
  assert.equal(st.summary.n, 1); assert.equal(st.summary.byLeague[0].key, "mlb");
});

test("poll: a started game or a missing US list is a logged miss, not a bet", async () => {
  ss._reset();
  ss._state.wallets = [W]; ss._state.primed = true;
  ss._set({ fetchFn: async () => ({ ok: true, json: async () => [trade({ transactionHash: "0x1" })] }),
    pmMod: { cachedSportsMoneylines: () => ({ at: 1, markets: [{ ...US[0], gameStartIso: "2000-01-01T00:00:00Z" }] }), getBBO: async () => null, getSettlement: async () => null } });
  await ss._poll(Date.now());
  assert.equal(ss._state.open.length, 0); assert.match(ss._state.misses[0].why, /already started/);
  ss._reset(); ss._state.wallets = [W]; ss._state.primed = true;
  ss._set({ pmMod: { cachedSportsMoneylines: () => null, getBBO: async () => null, getSettlement: async () => null } });
  await ss._poll(Date.now());
  assert.match(ss._state.misses[0].why, /no US sports list/);
});

test("REAL sports: $1 FOK on name-matched pre-game bets only, with every brake", async () => {
  const orders = [];
  let bp = 20, halted = null, claimOk = true, settlement = null;
  const pmMod = { cachedSportsMoneylines: () => ({ at: 1, markets: US }), getBBO: async () => ({ bid: 0.41, ask: 0.44 }), getSettlement: async () => settlement,
    getBuyingPower: async () => ({ buyingPower: bp }),
    buyOutcomeFOK: async o => { orders.push(o); return { filled: true, qty: 2, cost: 0.92, fillPrice: 0.46, orderId: "o1" }; } };
  const setup = () => { ss._reset(); ss._state.wallets = [W]; ss._state.primed = true; ss._set({ pmMod, halted: () => halted, claimFn: async () => claimOk }); };
  ss.LIVE.on = true;
  wr._put(W, { byLeague: [{ key: "sports:mlb", n: 40, wins: 26, winRate: 0.65, pnl: 310 }] });
  try {
    // Name match: the Guardians. One real $1 buy of YES (Up = long) at 44¢ + 2¢ slip.
    setup();
    ss._set({ fetchFn: async () => ({ ok: true, json: async () => [trade({ transactionHash: "0xa" })] }) });
    await ss._poll(Date.now());
    assert.equal(orders.length, 1);
    assert.deepEqual({ slug: orders[0].slug, side: orders[0].side, sizeUsd: orders[0].sizeUsd, price: orders[0].price, slip: orders[0].slip },
      { slug: "aec-mlb-cle-tb-2026-10-13", side: "Up", sizeUsd: 1, price: 0.44, slip: 0.02 });
    const live = ss._state.live.open[0];
    assert.equal(live.qty, 2); assert.equal(live.cost, 0.92);
    // Settles on what was really paid: 2 shares won $2 − $0.92 − fee.
    settlement = 1;
    await ss._settle(live.start + 4 * 3600_000);
    assert.ok(Math.abs(ss._state.live.closed[0].pnl - (2 - 0.92 - live.fee)) < 0.011);
    assert.equal(ss.sportsShadowStatus().live.bets, 1);

    // Backing the Rays: inferred "other team" → paper only.
    orders.length = 0; setup();
    ss._set({ fetchFn: async () => ({ ok: true, json: async () => [trade({ transactionHash: "0xb", outcome: "Rays" })] }) });
    await ss._poll(Date.now());
    assert.equal(ss._state.open.length, 1, "paper copy still made"); assert.equal(orders.length, 0, "no real order");

    // Halted from /copy, another copy holds the claim, or no buying power: no order.
    for (const [why, fn] of [["halted", () => { halted = "stopped from /copy"; }], ["claim", () => { claimOk = false; }], ["buying power", () => { bp = 0.5; }]]) {
      halted = null; claimOk = true; bp = 20; orders.length = 0; setup(); fn();
      ss._set({ fetchFn: async () => ({ ok: true, json: async () => [trade({ transactionHash: "0x" + why })] }) });
      await ss._poll(Date.now());
      assert.equal(orders.length, 0, why);
    }
  } finally { ss.LIVE.on = false; }
});

test("REAL sports brakes: price band, loss limits, one bet per game", () => {
  ss._reset(); ss.LIVE.on = true;
  wr._put(W, { byLeague: [{ key: "sports:mlb", n: 40, wins: 26, winRate: 0.65, pnl: 310 }] });
  try {
    const bet = { usSlug: "s1", px: 0.5, wallet: W, league: "mlb" }, m = { exact: true };
    assert.equal(ss.liveBlock(bet, m), null);
    assert.match(ss.liveBlock({ ...bet, px: 0.95 }, m), /outside 10-90/);
    assert.match(ss.liveBlock(bet, { exact: false }), /inferred/);
    ss._state.live.closed.push({ usSlug: "old", won: false, pnl: -5.2, closedAt: Date.now() });
    assert.match(ss.liveBlock(bet, m), /daily limit/);
    ss._state.live.closed = [{ usSlug: "old", won: false, pnl: -10.5, closedAt: 0 }];
    assert.match(ss.liveBlock(bet, m), /-\$10 limit/);
    ss._state.live.closed = []; ss._state.live.open = [{ usSlug: "s1" }];
    assert.match(ss.liveBlock(bet, m), /already has a real bet/);
  } finally { ss.LIVE.on = false; }
});

test("wallet report: classifies positions, aggregates by league and price, gates real money", async () => {
  assert.deepEqual(wr.classify({ eventSlug: "mlb-cle-tb-2026-10-13" }), { kind: "sports", league: "mlb" });
  assert.equal(wr.classify({ eventSlug: "btc-updown-15m-1790000000" }).kind, "crypto");
  assert.equal(wr.classify({ eventSlug: "presidential-election-winner-2028" }).kind, "other");
  const rows = [
    { eventSlug: "mlb-a-b-2026-10-01", avgPrice: 0.40, totalBought: 100, realizedPnl: 60 },
    { eventSlug: "mlb-c-d-2026-10-02", avgPrice: 0.60, totalBought: 100, realizedPnl: -60 },
    { eventSlug: "nba-e-f-2026-10-03", avgPrice: 0.70, totalBought: 50, realizedPnl: 15 },
    { eventSlug: "btc-updown-15m-1790000000", avgPrice: 0.80, totalBought: 20, realizedPnl: 4 },
    { eventSlug: "mlb-x", avgPrice: 2, realizedPnl: 1 },   // unusable price
  ];
  wr._set({ fetchFn: async () => ({ ok: true, json: async () => rows }) });
  const rep = await wr.buildReport("0xabc");
  assert.equal(rep.usable, 4);
  const mlb = rep.byLeague.find(g => g.key === "sports:mlb");
  assert.equal(mlb.n, 2); assert.equal(mlb.wins, 1); assert.equal(mlb.pnl, 0); assert.equal(mlb.cost, 100);
  assert.equal(rep.byKind.find(g => g.key === "sports").n, 3);
  assert.equal(rep.sportsByBand.length, 3);
  // Gate: too few, losing, missing, proven.
  assert.match(wr.leagueProven(rep, "mlb").why, /only 2/);
  assert.match(wr.leagueProven({ byLeague: [{ key: "sports:nhl", n: 30, wins: 12, winRate: 0.4, pnl: -90 }] }, "nhl").why, /loses money/);
  assert.match(wr.leagueProven(rep, "nfl").why, /no finished nfl/);
  assert.equal(wr.leagueProven({ byLeague: [{ key: "sports:mlb", n: 40, wins: 26, winRate: 0.65, pnl: 310 }] }, "mlb").ok, true);
  // SPORTS SHADOW real money obeys it.
  ss._reset(); ss.LIVE.on = true;
  try {
    const bet = { usSlug: "s9", px: 0.5, wallet: "0xnorecord", league: "mlb" };
    assert.match(ss.liveBlock(bet, { exact: true }), /record hasn't loaded/);
    wr._put("0xnorecord", { byLeague: [{ key: "sports:mlb", n: 5, wins: 4, winRate: 0.8, pnl: 20 }] });
    assert.match(ss.liveBlock(bet, { exact: true }), /needs a proven record/);
  } finally { ss.LIVE.on = false; }
});

test("wallet report: pages through every closed position, 50 at a time", async () => {
  const all = Array.from({ length: 120 }, (_, i) => ({ conditionId: "c" + i, outcomeIndex: 0, eventSlug: `nba-a-b-2026-10-${String(1 + (i % 28)).padStart(2, "0")}`, avgPrice: 0.5, totalBought: 10, realizedPnl: i % 3 ? 5 : -5 }));
  const urls = [];
  wr._set({ fetchFn: async url => { urls.push(url); const off = Number(/offset=(\d+)/.exec(url)[1]); return { ok: true, json: async () => all.slice(off, off + 50) }; } });
  const rep = await wr.buildReport("0xpages");
  assert.equal(rep.rows, 120, "all three pages read");
  assert.match(urls[0], /limit=50&offset=0/); assert.match(urls[2], /offset=100/);
  assert.equal(rep.byKind[0].n, 120); assert.equal(rep.byKind[0].wins, 80, "losers included, not just the first page of winners");
});

test("wallet report: losers held to the result (in /positions) are counted, open bets are not", async () => {
  const closed = [{ conditionId: "w1", outcomeIndex: 0, eventSlug: "nfl-a-b-2026-10-01", avgPrice: 0.5, totalBought: 100, realizedPnl: 50 }];
  const held = [
    { conditionId: "l1", outcomeIndex: 0, eventSlug: "nfl-c-d-2026-10-02", avgPrice: 0.6, totalBought: 100, curPrice: 0, cashPnl: -60, realizedPnl: 0 },   // lost
    { conditionId: "o1", outcomeIndex: 0, eventSlug: "nfl-e-f-2026-10-20", avgPrice: 0.5, totalBought: 100, curPrice: 0.55, cashPnl: 5, realizedPnl: 0 }, // game not over
  ];
  wr._set({ fetchFn: async url => ({ ok: true, json: async () => (/offset=0/.test(url) ? (/closed-positions/.test(url) ? closed : held) : []) }) });
  const rep = await wr.buildReport("0xheld");
  assert.equal(rep.closed, 1); assert.equal(rep.heldAtResult, 1, "only the settled loser");
  const nfl = rep.byLeague.find(g => g.key === "sports:nfl");
  assert.equal(nfl.n, 2); assert.equal(nfl.wins, 1); assert.equal(nfl.pnl, -10);
});
