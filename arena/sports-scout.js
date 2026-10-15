/**
 * arena/sports-scout.js — SPORTS SCOUT: finds the wallets that actually win at sports.
 *
 * Every 3 hours it reads recently finished sports games on global Polymarket (gamma events,
 * closed, newest first), and every trade in each game's main markets (data-api, not the US
 * gateway). With the settled result it scores every wallet per game: money in, money out,
 * $1 per winning share. Across games that gives each wallet a record by league.
 *
 * "Sharp" wallets: SCOUT_MIN_GAMES+ settled games (8), in profit, SCOUT_MIN_ROI+ return (5%),
 * SCOUT_MIN_WIN+ of games won (55%). The best SCOUT_TOP (10), ranked by profit per game
 * weighted by sample size, are handed to SPORTS SHADOW to follow. Real money only copies a
 * wallet in a league where it has SCOUT_LEAGUE_MIN (4)+ settled games in profit.
 *
 * Read-only. GET /api/sportsscout. Off with SPORTS_SCOUT=false.
 */
import { saveJSON, loadJSON } from "./state.js";

const GAMMA = process.env.COPY_GAMMA_URL || "https://gamma-api.polymarket.com";
const DATA = process.env.COPY_DATA_URL || "https://data-api.polymarket.com";
const envNum = (k, d) => { const v = Number(process.env[k]); return process.env[k] != null && process.env[k] !== "" && Number.isFinite(v) ? v : d; };
export const SCOUT = { minGames: envNum("SCOUT_MIN_GAMES", 8), minRoi: envNum("SCOUT_MIN_ROI", 0.05), minWin: envNum("SCOUT_MIN_WIN", 0.55),
  top: envNum("SCOUT_TOP", 10), leagueMin: envNum("SCOUT_LEAGUE_MIN", 4), gamesPerRun: envNum("SCOUT_GAMES_PER_RUN", 80), keepDays: envNum("SCOUT_KEEP_DAYS", 21) };
const KEY = "arena:sportsscout:v1", REFRESH_MS = 3 * 3600_000, MAX_TRADE_PAGES = 6, PAGE = 500;
const NOT_MAIN = /spread|handicap|o\/u|over\/under|total|points|rebounds|assists|yards|1st|first half|2nd half|quarter|inning|props?\b|exact|both teams|clean sheet|corners|cards/i;

const parseArr = v => { if (Array.isArray(v)) return v; try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } };
const leagueOf = slug => { const s = String(slug || "").toLowerCase(); return /\d{4}-\d{2}-\d{2}/.test(s) && /^[a-z0-9]+-/.test(s) ? s.split("-")[0] : null; };

/** A closed gamma event → its settled main markets: [{ conditionId, outcomes, winner, league, eventSlug, end }]. */
export function settledMarkets(ev) {
  const league = leagueOf(ev?.slug);
  if (!league) return [];
  const end = Date.parse(ev.endDate || ev.closedTime || "") || null;
  const out = [];
  for (const m of ev.markets || []) {
    if (!m?.conditionId || NOT_MAIN.test(String(m.question || m.groupItemTitle || ""))) continue;
    const outcomes = parseArr(m.outcomes), prices = parseArr(m.outcomePrices).map(Number);
    if (outcomes.length < 2 || prices.length !== outcomes.length) continue;
    const winner = prices.findIndex(p => p >= 0.99);
    if (winner < 0 || prices.filter(p => p >= 0.99).length !== 1) continue;   // not settled cleanly
    out.push({ conditionId: m.conditionId, outcomes, winner, league, eventSlug: ev.slug, end });
  }
  return out;
}

/** Per-wallet result in one settled market from its trades: { wallet: { cost, pnl, name } }. */
export function scoreMarket(trades, mk) {
  const per = new Map();
  for (const t of trades) {
    const w = String(t.proxyWallet || "").toLowerCase(); if (!w) continue;
    const side = String(t.side || "").toUpperCase(), size = Number(t.size) || 0, price = Number(t.price) || 0;
    let idx = Number.isInteger(Number(t.outcomeIndex)) ? Number(t.outcomeIndex) : mk.outcomes.indexOf(t.outcome);
    if (!(size > 0 && price > 0) || idx < 0 || (side !== "BUY" && side !== "SELL")) continue;
    const r = per.get(w) || { cash: 0, cost: 0, shares: new Map(), name: t.name || t.pseudonym || null };
    if (side === "BUY") { r.cash -= size * price; r.cost += size * price; r.shares.set(idx, (r.shares.get(idx) || 0) + size); }
    else { r.cash += size * price; r.shares.set(idx, (r.shares.get(idx) || 0) - size); }
    per.set(w, r);
  }
  const out = {};
  for (const [w, r] of per) {
    if (r.cost < 1) continue;   // dust
    const payout = Math.max(0, r.shares.get(mk.winner) || 0);
    out[w] = { cost: +r.cost.toFixed(2), pnl: +(r.cash + payout).toFixed(2), name: r.name };
  }
  return out;
}

/** Wallet records from per-game results [{ wallet, league, cost, pnl, end }]. */
export function records(results, cfg = SCOUT) {
  const by = new Map();
  for (const r of results) {
    const w = by.get(r.wallet) || { wallet: r.wallet, name: r.name || null, games: 0, wins: 0, cost: 0, pnl: 0, leagues: {} };
    w.games++; if (r.pnl > 0) w.wins++; w.cost += r.cost; w.pnl += r.pnl; if (r.name) w.name = r.name;
    const l = (w.leagues[r.league] ||= { games: 0, wins: 0, pnl: 0 }); l.games++; if (r.pnl > 0) l.wins++; l.pnl = +(l.pnl + r.pnl).toFixed(2);
    by.set(r.wallet, w);
  }
  return [...by.values()].map(w => ({ ...w, cost: +w.cost.toFixed(2), pnl: +w.pnl.toFixed(2), winRate: +(w.wins / w.games).toFixed(3), roi: w.cost > 0 ? +(w.pnl / w.cost).toFixed(3) : 0,
    sharp: w.games >= cfg.minGames && w.pnl > 0 && w.cost > 0 && w.pnl / w.cost >= cfg.minRoi && w.wins / w.games >= cfg.minWin,
    score: +(w.games ? (w.pnl / w.games) * Math.sqrt(w.games) : 0).toFixed(2) }));
}
export const pickSharp = (recs, cfg = SCOUT) => recs.filter(r => r.sharp).sort((a, b) => b.score - a.score).slice(0, cfg.top);

/** Has this wallet proven itself in this league (for real money)? */
export function scoutProven(wallet, league, cfg = SCOUT) {
  const r = state.records.find(x => x.wallet === String(wallet || "").toLowerCase());
  if (!r) return { ok: false, why: "not in the sports scout's records" };
  if (!r.sharp) return { ok: false, why: "not rated sharp by the sports scout" };
  const l = r.leagues?.[league];
  if (!l || l.games < cfg.leagueMin) return { ok: false, why: `only ${l?.games || 0} settled ${league} games on record (need ${cfg.leagueMin})` };
  if (!(l.pnl > 0)) return { ok: false, why: `losing in ${league} (${l.games} games, $${l.pnl})` };
  return { ok: true, why: `${l.games} ${league} games, ${l.wins} won, +$${l.pnl.toFixed(0)}` };
}

// ── Runtime ─────────────────────────────────────────────────────────
const state = { enabled: false, results: [], done: [], records: [], sharp: [], lastRunAt: 0, lastError: null, lastRun: null };
let fetchImpl = (...a) => fetch(...a), onSharp = () => {};
async function getJSON(url) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${url.replace(/^https:\/\//, "").slice(0, 70)}`);
  return res.json();
}

export async function runScout(now = Date.now()) {
  const done = new Set(state.done);
  const markets = [];
  for (let off = 0; off < 1000 && markets.length < SCOUT.gamesPerRun * 2; off += 100) {
    const evs = await getJSON(`${GAMMA}/events?closed=true&tag_slug=sports&order=endDate&ascending=false&limit=100&offset=${off}`);
    const list = Array.isArray(evs) ? evs : evs?.data || [];
    if (!list.length) break;
    for (const ev of list) for (const m of settledMarkets(ev)) if (!done.has(m.conditionId) && (!m.end || now - m.end < SCOUT.keepDays * 86400_000)) markets.push(m);
  }
  let games = 0, trades = 0;
  for (const mk of markets.slice(0, SCOUT.gamesPerRun)) {
    const rows = [];
    for (let p = 0; p < MAX_TRADE_PAGES; p++) {
      const page = await getJSON(`${DATA}/trades?market=${mk.conditionId}&limit=${PAGE}&offset=${p * PAGE}`).catch(() => []);
      const list = Array.isArray(page) ? page : [];
      rows.push(...list);
      if (list.length < PAGE) break;
    }
    trades += rows.length;
    for (const [wallet, r] of Object.entries(scoreMarket(rows, mk))) state.results.push({ wallet, league: mk.league, cost: r.cost, pnl: r.pnl, end: mk.end || now, name: r.name, m: mk.conditionId });
    state.done.push(mk.conditionId); games++;
  }
  // Keep the window rolling: results from the last keepDays only.
  state.results = state.results.filter(r => now - r.end < SCOUT.keepDays * 86400_000);
  state.done = state.done.slice(-5000);
  state.records = records(state.results);
  state.sharp = pickSharp(state.records);
  state.lastRunAt = now;
  state.lastRun = { markets: games, trades, wallets: state.records.length, sharp: state.sharp.length };
  await saveJSON(KEY, { results: state.results, done: state.done, lastRunAt: now });
  console.log(`  🔭 [sports-scout] read ${games} settled games (${trades} trades): ${state.records.length} wallets scored, ${state.sharp.length} sharp${state.sharp.length ? `: ${state.sharp.slice(0, 5).map(s => `${s.name || s.wallet.slice(0, 8)} ${s.games}g ${Math.round(s.winRate * 100)}% +$${s.pnl.toFixed(0)}`).join(", ")}` : ""}`);
  onSharp(state.sharp.map(s => s.wallet));
  return state.lastRun;
}

export function sportsScoutStatus() {
  return { enabled: state.enabled, lastRunAt: state.lastRunAt, lastRun: state.lastRun, lastError: state.lastError, cfg: SCOUT, games: new Set(state.results.map(r => r.m)).size,
    sharp: state.sharp, near: state.records.filter(r => !r.sharp && r.games >= Math.ceil(SCOUT.minGames / 2) && r.pnl > 0).sort((a, b) => b.score - a.score).slice(0, 5) };
}
export const sharpWallets = () => state.sharp.map(s => s.wallet);

export async function startSportsScout({ onSharpWallets } = {}) {
  if (process.env.SPORTS_SCOUT === "false") { console.log("🔭 Sports scout off (SPORTS_SCOUT=false)"); return; }
  if (state.enabled) return;
  if (onSharpWallets) onSharp = onSharpWallets;
  const saved = await loadJSON(KEY);
  if (saved?.results) { state.results = saved.results; state.done = saved.done || []; state.lastRunAt = saved.lastRunAt || 0; state.records = records(state.results); state.sharp = pickSharp(state.records); onSharp(state.sharp.map(s => s.wallet)); }
  state.enabled = true;
  const run = async () => { try { await runScout(); state.lastError = null; } catch (err) { state.lastError = err.message; console.log(`  🔭 [sports-scout] failed: ${err.message}`); } };
  setTimeout(run, 45_000);
  setInterval(run, REFRESH_MS);
  console.log(`🔭 Sports scout on: scores wallets on settled sports games every ${REFRESH_MS / 3600_000}h, follows the top ${SCOUT.top} sharp ones`);
}

export function _set({ fetchFn, onSharpFn } = {}) { if (fetchFn) fetchImpl = fetchFn; if (onSharpFn) onSharp = onSharpFn; }
export function _reset() { Object.assign(state, { results: [], done: [], records: [], sharp: [], lastRunAt: 0, lastRun: null }); }
export const _state = state;
