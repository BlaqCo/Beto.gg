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
 * Pre-game only. One bet per wallet per US market. Off with SPORTS_SHADOW=false.
 * Wallets: the primary wallet plus COPY_SPORTS_WALLETS.
 *
 * REAL MONEY (off unless SPORTS_LIVE=true): each paper copy also places a real
 * SPORTS_LIVE_STAKE ($1) fill-or-kill buy, but only when the team was matched BY NAME (an
 * inferred "other team" stays paper), only pre-game, priced 10-90¢, one per US market (a
 * Redis claim stops a deploy overlap from doubling it), with buying power checked first.
 * Stops for the day at -SPORTS_LIVE_DAILY_LOSS ($5) and for good at -SPORTS_LIVE_MAX_LOSS
 * ($10). SHADOW's STOP REAL MONEY button on /copy stops it too. Unless
 * SPORTS_LIVE_REQUIRE_RECORD=false, real money also needs the wallet's own record in that
 * league to be proven (arena/wallet-report.js: 20+ finished positions, in profit).
 */
import { takerFee } from "../fees.js";
import { saveJSON, loadJSON, claimOnce } from "./state.js";
import { reportFor, leagueProven } from "./wallet-report.js";
import { scoutProven } from "./sports-scout.js";

const DATA = process.env.COPY_DATA_URL || "https://data-api.polymarket.com";
const KEY = "arena:sportsshadow:v1", POLL_MS = 60_000, STAKE = 10;
const SETTLE_AFTER_MS = 3 * 3600_000, SETTLE_EVERY_MS = 15 * 60_000, GIVE_UP_MS = 48 * 3600_000;
// Polymarket US lists main "who wins" markets for major leagues only. These are bets we can't copy.
const SIDE_BET = /exact score|o\/u|over\/under|spread|both teams|end in a draw|\bdraw\b|handicap|1st half|2nd half|first half|corners|cards|total (goals|points|runs)/i;
const SIDE_SLUG = /-(more-markets|exact-score|draw|total|spread)(-|$)/i;
/** US leagues, from the live US sports list ("aec-<league>-..."); null if the list isn't loaded. */
export function usLeagues(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return new Set(list.map(m => String(m.slug || "").toLowerCase().split("-")[1]).filter(Boolean));
}
/** Why a signal can't be copied onto US at all (quietly skipped), or null. */
export function uncopyable(s, leagues) {
  if (SIDE_BET.test(s.title || "") || SIDE_SLUG.test(s.slug || "") || SIDE_SLUG.test(s.eventSlug || "")) return "side bet";
  if (leagues && !leagues.has(s.league)) return "league not on US";
  return null;
}
export const LEAGUES = ["mlb", "nba", "nfl", "nhl", "wnba", "ncaaf", "ncaab", "cfb", "cbb", "epl", "laliga", "la-liga", "seriea", "serie-a", "bundesliga", "ligue1", "ligue-1", "mls", "ucl", "uel", "ufc", "atp", "wta"];
const envNum = (k, d) => { const v = Number(process.env[k]); return process.env[k] != null && process.env[k] !== "" && Number.isFinite(v) ? v : d; };
export const LIVE = { on: process.env.SPORTS_LIVE === "true", stake: envNum("SPORTS_LIVE_STAKE", 1), dailyLoss: envNum("SPORTS_LIVE_DAILY_LOSS", 5),
  maxLoss: envNum("SPORTS_LIVE_MAX_LOSS", 10), minPx: 0.10, maxPx: 0.90, slip: 0.02 };
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
/** Team names on a US market's YES (long) and NO (short) sides: from "Will X win" or the side names. */
export function sideTeams(m) {
  const y = yesTeamOf(m.question);
  if (y) return { yes: y, no: null };
  const named = x => x && !/^(yes|no)$/i.test(x.name.trim()) && x.name.trim() ? norm(x.name) : null;
  const sides = Array.isArray(m.sides) ? m.sides : [];
  const yes = named(sides.find(x => x.long)), no = named(sides.find(x => !x.long));
  return yes ? { yes, no } : null;
}

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
  cands = cands.filter(m => sideTeams(m));
  if (!cands.length) return { why: `no US market for ${ev || sig.slug}` };
  const b = backedTeam(sig);
  if (!b.team) return { why: b.why };
  const hit = cands.find(m => sameTeam(sideTeams(m).yes, b.team));
  if (hit) return { market: hit, buy: b.against ? "NO" : "YES", exact: !b.against };
  // "Who will win" markets name both sides: backing the short-side team is a named NO.
  const hitNo = cands.find(m => sameTeam(sideTeams(m).no, b.team));
  if (hitNo) return { market: hitNo, buy: b.against ? "YES" : "NO", exact: !b.against };
  if (cands.length === 1 && !THREE_WAY.has(sig.league)) return { market: cands[0], buy: b.against ? "YES" : "NO", exact: false };   // two teams: the other one
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
const state = { enabled: false, skipped: {}, wallets: [], base: [], scouted: [], primedWallets: new Set(), seen: [], open: [], closed: [], misses: [], started: false, lastPollAt: 0, lastError: null, primed: false,
  live: { open: [], closed: [], missed: 0 } };
let pm = null, fetchImpl = (...a) => fetch(...a), isHalted = () => null, claim = claimOnce;
const events = [];
function emit(msg) { events.push({ t: Date.now(), msg }); if (events.length > 100) events.shift(); console.log(`  🏟 [sports-shadow] ${msg}`); }
const save = () => saveJSON(KEY, { primedWallets: [...state.primedWallets], seen: state.seen.slice(-3000), open: state.open, closed: state.closed.slice(-300), misses: state.misses.slice(-60),
  live: { open: state.live.open, closed: state.live.closed.slice(-300), missed: state.live.missed } });

async function poll(now = Date.now()) {
  state.lastPollAt = now;
  const fresh = [];
  if (state.primed && !state.primedWallets.size) state.wallets.forEach(w => state.primedWallets.add(w));   // saved before per-wallet priming
  let primedNow = 0;
  for (const w of state.wallets) {
    const res = await fetchImpl(`${DATA}/trades?user=${w}&limit=100`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`data-api ${res.status}`);
    const rows = await res.json();
    const mine = [];
    for (const t of Array.isArray(rows) ? rows : []) { const s = toSignal(t); if (s && !state.seen.includes(s.id)) mine.push(s); }
    // A wallet's first look: remember what's there, copy only what it does from now on.
    if (!state.primedWallets.has(w)) { state.primedWallets.add(w); state.seen.push(...mine.map(s => s.id)); primedNow++; continue; }
    fresh.push(...mine);
  }
  if (primedNow) { state.primed = true; emit(`now watching ${primedNow} new wallet(s) (${state.wallets.length} in all); their earlier bets are skipped`); }
  if (primedNow && !fresh.length) { await save(); return; }
  if (!fresh.length) return;
  const list = pm.cachedSportsMoneylines()?.markets || [];
  // No US list yet (just restarted): leave these bets unseen and try them again on the next poll.
  if (!list.length) { if (primedNow) await save(); return; }
  const leagues = usLeagues(list);
  for (const s of fresh.sort((a, b) => a.t - b.t)) {
    state.seen.push(s.id);
    const skip = uncopyable(s, leagues);
    if (skip) { state.skipped[skip] = (state.skipped[skip] || 0) + 1; continue; }
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
    if (LIVE.on) { try { await maybeLive(bet, m, now); } catch (err) { emit(`REAL sports bet error: ${err.message}`); } }
  }
  await save();
}
// ── Real money ──────────────────────────────────────────────────────
const dayOf = t => new Date(t).toISOString().slice(0, 10);
export function liveTotals(now = Date.now()) {
  const done = state.live.closed.filter(b => b.won != null);
  return { bets: done.length, wins: done.filter(b => b.won).length, pnl: +done.reduce((a, b) => a + b.pnl, 0).toFixed(2),
    today: +done.filter(b => dayOf(b.closedAt) === dayOf(now)).reduce((a, b) => a + b.pnl, 0).toFixed(2) };
}
/** Why a real sports bet can't be placed now, or null if it can. */
export function liveBlock(bet, m, now = Date.now()) {
  if (!LIVE.on) return "real sports money is off (SPORTS_LIVE is not true)";
  const h = isHalted(); if (h) return `real money halted: ${h}`;
  if (!m.exact) return "the team was inferred, not matched by name, so this one stays paper";
  // Only copy real money in leagues where the wallet has a proven, profitable record.
  if (process.env.SPORTS_LIVE_REQUIRE_RECORD !== "false") {
    // Proven by the sports scout (settled games it scored), or by the wallet's own closed positions.
    const sc = scoutProven(bet.wallet, bet.league);
    if (!sc.ok) {
      const rep = reportFor(bet.wallet);
      if (!rep) return `${sc.why}, and the wallet's own sports record hasn't loaded; real money needs a proven record`;
      const p = leagueProven(rep, bet.league);
      if (!p.ok) return `${p.why}; real money needs a proven record`;
    }
  }
  if (bet.px < LIVE.minPx || bet.px > LIVE.maxPx) return `price ${Math.round(bet.px * 100)}¢ is outside ${Math.round(LIVE.minPx * 100)}-${Math.round(LIVE.maxPx * 100)}¢`;
  const t = liveTotals(now);
  if (t.pnl <= -LIVE.maxLoss) return `total real sports loss $${(-t.pnl).toFixed(2)} reached the -$${LIVE.maxLoss} limit`;
  if (t.today <= -LIVE.dailyLoss) return `today's real sports loss $${(-t.today).toFixed(2)} reached the -$${LIVE.dailyLoss} daily limit`;
  if (state.live.open.concat(state.live.closed).some(b => b.usSlug === bet.usSlug)) return "already has a real bet on this game";
  return null;
}
async function maybeLive(bet, m, now) {
  const why = liveBlock(bet, m, now);
  if (why) { emit(`REAL sports bet skipped: ${why}`); return; }
  let mine = false;
  try { mine = await claim(`arena:sportsshadow:live:${bet.usSlug}`, 7 * 86400); } catch (err) { emit(`REAL sports bet skipped: couldn't confirm no other copy is betting (${err.message})`); return; }
  if (!mine) { emit("REAL sports bet skipped: another running copy of the bot already bet this game"); return; }
  const bp = await pm.getBuyingPower();
  if (!(bp?.buyingPower >= LIVE.stake)) { emit(`REAL sports bet skipped: buying power $${(bp?.buyingPower || 0).toFixed(2)} is under $${LIVE.stake}`); return; }
  const r = await pm.buyOutcomeFOK({ slug: bet.usSlug, side: bet.buy === "YES" ? "Up" : "Down", sizeUsd: LIVE.stake, price: bet.px, slip: LIVE.slip, minQty: m.market.minQty || 0.01 });
  if (!r.filled) { state.live.missed++; emit(`REAL ${bet.buy} on "${bet.usQuestion}" up to ${Math.round(Math.min(0.99, bet.px + LIVE.slip) * 100)}¢ didn't fill (${r.error})`); return; }
  const px = +(r.cost / r.qty).toFixed(4), fee = +takerFee(r.qty, px).toFixed(4);
  state.live.open.push({ ...bet, px, qty: r.qty, cost: r.cost, fee, orderId: r.orderId || null, lastTry: 0 });
  emit(`REAL BUY ${bet.buy} "${bet.usQuestion}": ${r.qty} shares @ ${Math.round(px * 100)}¢ = $${r.cost.toFixed(2)}`);
}

const missedGames = new Set();
function miss(s, why) {
  // One line per game and reason: a wallet often places many trades on the same game.
  const k = `${s.eventSlug || s.slug}|${why}`;
  if (missedGames.has(k)) return;
  missedGames.add(k); if (missedGames.size > 2000) missedGames.delete(missedGames.values().next().value);
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
  // Real bets settle the same way, on what was really paid.
  for (const b of [...state.live.open]) {
    if (now < b.start + SETTLE_AFTER_MS || now - b.lastTry < SETTLE_EVERY_MS) continue;
    b.lastTry = now;
    const out = await pm.getSettlement(b.usSlug).catch(() => null);
    if (out == null && now - b.start <= GIVE_UP_MS) continue;
    state.live.open = state.live.open.filter(x => x !== b);
    const won = out == null ? null : (out === 1) === (b.buy === "YES");
    const pnl = won == null ? 0 : +((won ? b.qty : 0) - b.cost - b.fee).toFixed(2);
    state.live.closed.push({ ...b, won, pnl, closedAt: now });
    changed = true;
    emit(won == null ? `REAL VOID "${b.usQuestion}": no result after 48h (check Polymarket)` : `REAL ${won ? "WON" : "LOST"} ${b.buy} "${b.usQuestion}": ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
  }
  if (changed) await save();
}

/** The sports scout's sharp wallets: followed alongside the primary/listed ones. */
export function setScoutedWallets(list = []) {
  const next = [...new Set(list.map(w => String(w).toLowerCase()).filter(w => /^0x[0-9a-f]{40}$/.test(w)))];
  const added = next.filter(w => !state.wallets.includes(w));
  state.scouted = next;
  state.wallets = [...new Set([...state.base, ...next])];
  if (added.length) emit(`sports scout: following ${added.length} more sharp wallet(s); ${state.wallets.length} in all`);
  return state.wallets;
}

export function sportsShadowStatus() {
  return { enabled: state.enabled, wallets: state.wallets, base: state.base, scouted: state.scouted, skipped: state.skipped, lastPollAt: state.lastPollAt, lastError: state.lastError, usListAt: pm?.cachedSportsMoneylines?.()?.at || null,
    live: { on: LIVE.on, stake: LIVE.stake, dailyLoss: LIVE.dailyLoss, maxLoss: LIVE.maxLoss, halted: isHalted() || null, missed: state.live.missed, ...liveTotals(),
      open: state.live.open.slice(-20).reverse(), recent: state.live.closed.slice(-20).reverse() },
    summary: summary(state.closed), open: state.open.slice(-20).reverse(), recent: state.closed.slice(-20).reverse(), misses: state.misses.slice(-15).reverse(), events: events.slice(-30) };
}

export async function startSportsShadow({ wallets, halted }) {
  if (halted) isHalted = halted;
  if (process.env.SPORTS_SHADOW === "false") { console.log("🏟 SPORTS SHADOW off (SPORTS_SHADOW=false)"); return; }
  if (state.started) return;
  state.started = true;
  pm = await import("../polymarket-us.js");
  const extra = (process.env.COPY_SPORTS_WALLETS || "").split(",").map(a => a.trim().toLowerCase()).filter(a => /^0x[0-9a-f]{40}$/.test(a));
  state.base = [...new Set([...(wallets || []), ...extra])];
  state.wallets = [...new Set([...state.base, ...state.scouted])];
  const saved = await loadJSON(KEY);
  if (saved) { state.primedWallets = new Set(saved.primedWallets || []); state.seen = saved.seen || []; state.open = saved.open || []; state.closed = saved.closed || []; state.misses = saved.misses || []; state.primed = state.seen.length > 0;
    if (saved.live) state.live = { open: saved.live.open || [], closed: saved.live.closed || [], missed: saved.live.missed || 0 }; }
  state.enabled = true;
  const run = async () => { try { await poll(); await settleOpen(); state.lastError = null; } catch (err) { state.lastError = err.message; } };
  setTimeout(run, 30_000);
  setInterval(run, POLL_MS);
  if (LIVE.on) console.log(`🏟 SPORTS SHADOW REAL MONEY on: $${LIVE.stake} per copied bet (name-matched, pre-game, 10-90¢), -$${LIVE.dailyLoss}/day, off at -$${LIVE.maxLoss}`);
  console.log(`🏟 SPORTS SHADOW on: practice copies of ${state.wallets.length} wallet(s)' sports bets onto Polymarket US, checked every ${POLL_MS / 1000}s`);
}

// Tests.
export function _set({ pmMod, fetchFn, halted, claimFn } = {}) { if (pmMod) pm = pmMod; if (fetchFn) fetchImpl = fetchFn; if (halted) isHalted = halted; if (claimFn) claim = claimFn; }
export function _reset() { Object.assign(state, { primedWallets: new Set(), base: [], scouted: [], seen: [], open: [], closed: [], misses: [], primed: false, wallets: [], live: { open: [], closed: [], missed: 0 } }); events.length = 0; missedGames.clear(); }
export const _poll = poll, _settle = settleOpen, _state = state;
