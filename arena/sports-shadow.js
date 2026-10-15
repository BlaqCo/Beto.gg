/**
 * arena/sports-shadow.js — SPORTS SHADOW: practice copies of the primary wallet's sports bets.
 *
 * Every minute it reads the followed wallets' recent trades on global Polymarket (data-api,
 * a different service from the US gateway, so it doesn't touch the US rate limit). Each new
 * sports BUY is matched to the same game's moneyline on Polymarket US:
 *   - the US slug contains the global event slug (e.g. "mlb-cle-tb-2026-10-13"), else the
 *     same league, date and both team codes;
 *   - the team the wallet backed (its outcome, or the team in "Will X win" for a Yes) is
 *     found in the US question "Will <team> win ..." → buy YES, or on a two-team game the
 *     other side → buy NO.
 * A $10 paper bet is placed at the US order book's price (one read per bet), held to the
 * result. Every miss is kept with its reason, so the matching can be fixed from real data.
 * Pre-game only. One bet per wallet per US market. Paper only: no orders, no keys.
 * Off with SPORTS_SHADOW=false. Wallets: the primary wallet plus COPY_SPORTS_WALLETS.
 */
import { takerFee } from "../fees.js";
import { saveJSON, loadJSON } from "./state.js";

const DATA = process.env.COPY_DATA_URL || "https://data-api.polymarket.com";
const KEY = "arena:sportsshadow:v1", POLL_MS = 60_000, STAKE = 10;
const SETTLE_AFTER_MS = 3 * 3600_000, SETTLE_EVERY_MS = 15 * 60_000, GIVE_UP_MS = 48 * 3600_000;
export const LEAGUES = ["mlb", "nba", "nfl", "nhl", "wnba", "ncaaf", "ncaab", "cfb", "cbb", "epl", "laliga", "la-liga", "seriea", "serie-a", "bundesliga", "ligue1", "ligue-1", "mls", "ucl", "uel", "ufc", "atp", "wta"];
const THREE_WAY = new Set(["epl", "laliga", "la-liga", "seriea", "serie-a", "bundesliga", "ligue1", "ligue-1", "mls", "ucl", "uel"]);

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export const leagueOf = slug => { const p = String(slug || "").toLowerCase().split("-")[0]; return LEAGUES.includes(p) ? p : null; };

/** A data-api trade as a signal, or null if it isn't a sports BUY. */
export function toSignal(t) {
  const eventSlug = t.eventSlug || t.event_slug || "", slug = t.slug || "";
  const league = leagueOf(eventSlug) || leagueOf(slug);
  if (!league || String(t.side || "").toUpperCase() !== "BUY") return null;
  const price = Number(t.price), size = Number(t.size);
  if (!(price > 0 && price < 1 && size > 0)) return null;
  return { id: t.transactionHash || `${t.proxyWallet}-${t.timestamp}-${t.asset}`, wallet: String(t.proxyWallet || "").toLowerCase(), name: t.name || t.pseudonym || null,
    t: Number(t.timestamp) * 1000 || Date.now(), league, eventSlug, slug, title: t.title || "", outcome: t.outcome || "", price, usd: +(price * size).toFixed(2) };
}

/** "Will the Cleveland Guardians win against ..." → "the cleveland guardians". */
export const yesTeamOf = q => { const m = /will\s+(.+?)\s+(win|beat|defeat)\b/i.exec(String(q || "")); return m ? norm(m[1]).replace(/^the /, "") : null; };

/** Which team the wallet backed, as plain words, or null with a reason. */
export function backedTeam(sig) {
  const o = norm(sig.outcome);
  if (o && o !== "yes" && o !== "no") return { team: o };
  const t = yesTeamOf(sig.title);
  if (o === "yes" && t) return { team: t };
  if (o === "no" && t && !THREE_WAY.has(sig.league)) return { team: t, against: true };
  return { team: null, why: o === "no" ? `bet No on "${sig.title}" (can't map a No in a game that can draw)` : `can't tell the team from "${sig.title}" / outcome "${sig.outcome}"` };
}

/** Does team text a (e.g. "guardians") name the same team as b (e.g. "cleveland guardians")? */
export function sameTeam(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const last = x => x.split(" ").filter(w => w.length > 2).pop();
  const la = last(a), lb = last(b);
  return !!la && !!lb && (la === lb || b.split(" ").includes(la) || a.split(" ").includes(lb));
}

/**
 * The US market and side for a signal: { market, buy: "YES"|"NO" } or { why }.
 * markets: the US sports moneyline list (slug, question, gameStartIso, ask, bid, league).
 */
export function matchUs(sig, markets) {
  const ev = String(sig.eventSlug || "").toLowerCase();
  let cands = ev ? markets.filter(m => String(m.slug || "").toLowerCase().includes(ev)) : [];
  if (!cands.length) {
    // Same league, date and team codes: "mlb-cle-tb-2026-10-13" → codes [cle, tb], date 2026-10-13.
    const parts = ev.split("-"), date = (ev.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
    const codes = parts.slice(1).filter(p => /^[a-z]{2,4}$/.test(p));
    if (date && codes.length >= 2) cands = markets.filter(m => { const s = String(m.slug || "").toLowerCase(); return s.includes(date) && s.includes(`${sig.league}-`) && codes.every(c => s.includes(`-${c}-`) || s.endsWith(`-${c}`)); });
  }
  // Only "Will <team> win ..." markets (spreads and totals ask other questions).
  cands = cands.filter(m => yesTeamOf(m.question));
  if (!cands.length) return { why: `no US market for ${ev || sig.slug}` };
  const b = backedTeam(sig);
  if (!b.team) return { why: b.why };
  const hit = cands.find(m => { const y = yesTeamOf(m.question); return y && sameTeam(y, b.team); });
  if (hit) return { market: hit, buy: b.against ? "NO" : "YES" };
  if (cands.length === 1 && !THREE_WAY.has(sig.league)) return { market: cands[0], buy: b.against ? "YES" : "NO" };   // two teams: the other one
  return { why: `found ${cands.length} US market(s) for ${ev} but none names "${b.team}"` };
}

export const betPnl = (px, won) => { const n = STAKE / px, fee = takerFee(n, px); return +((won ? n : 0) - STAKE - fee).toFixed(2); };

export function summary(closed) {
  const s = closed.filter(b => b.won != null), n = s.length, wins = s.filter(b => b.won).length;
  const by = k => Object.entries(s.reduce((a, b) => { const g = (a[b[k]] ||= { n: 0, wins: 0, pnl: 0 }); g.n++; if (b.won) g.wins++; g.pnl = +(g.pnl + b.pnl).toFixed(2); return a; }, {})).map(([key, v]) => ({ key, ...v }));
  return { n, wins, winRate: n ? +(wins / n).toFixed(3) : null, pnl: +s.reduce((a, b) => a + b.pnl, 0).toFixed(2), perBet: n ? +(s.reduce((a, b) => a + b.pnl, 0) / n).toFixed(2) : null,
    byLeague: by("league"), byBand: by("band") };
}
const band = px => (px < 0.35 ? "under 35¢" : px < 0.5 ? "35-50¢" : px < 0.65 ? "50-65¢" : px < 0.8 ? "65-80¢" : "80¢+");

// ── Runtime ─────────────────────────────────────────────────────────
const state = { enabled: false, wallets: [], seen: [], open: [], closed: [], misses: [], started: false, lastPollAt: 0, lastError: null, primed: false };
let pm = null, fetchImpl = (...a) => fetch(...a);
const events = [];
function emit(msg) { events.push({ t: Date.now(), msg }); if (events.length > 100) events.shift(); console.log(`  🏟 [sports-shadow] ${msg}`); }
const save = () => saveJSON(KEY, { seen: state.seen.slice(-800), open: state.open, closed: state.closed.slice(-300), misses: state.misses.slice(-60) });

async function poll(now = Date.now()) {
  state.lastPollAt = now;
  const fresh = [];
  for (const w of state.wallets) {
    const res = await fetchImpl(`${DATA}/trades?user=${w}&limit=100`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`data-api ${res.status}`);
    const rows = await res.json();
    for (const t of Array.isArray(rows) ? rows : []) { const s = toSignal(t); if (s && !state.seen.includes(s.id)) fresh.push(s); }
  }
  // First run: remember what's there, copy only what comes after.
  if (!state.primed) { state.primed = true; state.seen.push(...fresh.map(s => s.id)); if (fresh.length) emit(`watching ${state.wallets.length} wallet(s); ${fresh.length} earlier sports buys skipped`); await save(); return; }
  if (!fresh.length) return;
  const list = pm.cachedSportsMoneylines()?.markets || [];
  for (const s of fresh.sort((a, b) => a.t - b.t)) {
    state.seen.push(s.id);
    if (!list.length) { miss(s, "no US sports list loaded yet (sports recorder off?)"); continue; }
    const m = matchUs(s, list);
    if (!m.market) { miss(s, m.why); continue; }
    const start = Date.parse(m.market.gameStartIso || "");
    if (Number.isFinite(start) && start <= now) { miss(s, `game already started (${m.market.slug}); pre-game only`); continue; }
    if (state.open.concat(state.closed).some(b => b.wallet === s.wallet && b.usSlug === m.market.slug)) continue;   // one bet per wallet per market
    let ask = m.market.ask, bid = m.market.bid;
    try { const b = await pm.getBBO(m.market.slug); if (b?.ask > 0 && b?.bid > 0) { ask = b.ask; bid = b.bid; } } catch { /* list price */ }
    const px = +(m.buy === "YES" ? ask : 1 - bid).toFixed(4);
    if (!(px >= 0.03 && px <= 0.97)) { miss(s, `US price ${px} out of range`); continue; }
    const bet = { id: s.id, wallet: s.wallet, name: s.name, league: s.league, title: s.title, outcome: s.outcome, theirPx: s.price, theirUsd: s.usd,
      usSlug: m.market.slug, usQuestion: m.market.question, buy: m.buy, px, band: band(px), start: Number.isFinite(start) ? start : now + 6 * 3600_000, openedAt: now, lastTry: 0 };
    state.open.push(bet);
    emit(`COPIED ${s.name || s.wallet.slice(0, 6)}: ${s.outcome} in "${s.title}" ($${s.usd} @ ${Math.round(s.price * 100)}¢) → paper ${m.buy} on US "${m.market.question}" @ ${Math.round(px * 100)}¢, $${STAKE}`);
  }
  await save();
}
function miss(s, why) {
  state.misses.push({ t: Date.now(), title: s.title, outcome: s.outcome, eventSlug: s.eventSlug, why });
  if (state.misses.length > 60) state.misses.shift();
  emit(`not copied: ${s.outcome} in "${s.title}": ${why}`);
}

async function settleOpen(now = Date.now()) {
  let changed = false;
  for (const b of [...state.open]) {
    if (now < b.start + SETTLE_AFTER_MS || now - b.lastTry < SETTLE_EVERY_MS) continue;
    b.lastTry = now;
    const out = await pm.getSettlement(b.usSlug).catch(() => null);
    const giveUp = now - b.start > GIVE_UP_MS;
    if (out == null && !giveUp) continue;
    state.open = state.open.filter(x => x !== b);
    const won = out == null ? null : (out === 1) === (b.buy === "YES");
    const pnl = won == null ? 0 : betPnl(b.px, won);
    state.closed.push({ ...b, won, pnl, closedAt: now });
    changed = true;
    emit(won == null ? `VOID "${b.usQuestion}": no result after 48h` : `${won ? "WON" : "LOST"} ${b.buy} "${b.usQuestion}" @ ${Math.round(b.px * 100)}¢: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
  }
  if (changed) await save();
}

export function sportsShadowStatus() {
  return { enabled: state.enabled, wallets: state.wallets, lastPollAt: state.lastPollAt, lastError: state.lastError, usListAt: pm?.cachedSportsMoneylines?.()?.at || null,
    summary: summary(state.closed), open: state.open.slice(-20).reverse(), recent: state.closed.slice(-20).reverse(), misses: state.misses.slice(-15).reverse(), events: events.slice(-30) };
}

export async function startSportsShadow({ wallets }) {
  if (process.env.SPORTS_SHADOW === "false") { console.log("🏟 SPORTS SHADOW off (SPORTS_SHADOW=false)"); return; }
  if (state.started) return;
  state.started = true;
  pm = await import("../polymarket-us.js");
  const extra = (process.env.COPY_SPORTS_WALLETS || "").split(",").map(a => a.trim().toLowerCase()).filter(a => /^0x[0-9a-f]{40}$/.test(a));
  state.wallets = [...new Set([...(wallets || []), ...extra])];
  if (!state.wallets.length) { console.log("🏟 SPORTS SHADOW: no wallets to follow"); return; }
  const saved = await loadJSON(KEY);
  if (saved) { state.seen = saved.seen || []; state.open = saved.open || []; state.closed = saved.closed || []; state.misses = saved.misses || []; state.primed = state.seen.length > 0; }
  state.enabled = true;
  const run = async () => { try { await poll(); await settleOpen(); state.lastError = null; } catch (err) { state.lastError = err.message; } };
  setTimeout(run, 30_000);
  setInterval(run, POLL_MS);
  console.log(`🏟 SPORTS SHADOW on: practice copies of ${state.wallets.length} wallet(s)' sports bets onto Polymarket US, checked every ${POLL_MS / 1000}s`);
}

// Tests.
export function _set({ pmMod, fetchFn } = {}) { if (pmMod) pm = pmMod; if (fetchFn) fetchImpl = fetchFn; }
export function _reset() { Object.assign(state, { seen: [], open: [], closed: [], misses: [], primed: false, wallets: [] }); events.length = 0; }
export const _poll = poll, _settle = settleOpen, _state = state;
