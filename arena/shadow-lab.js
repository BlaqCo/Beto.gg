/**
 * arena/shadow-lab.js — SHADOW LAB: where the AI agents hunt for SHADOW's edge.
 *
 *   1. Signal log. Every BTC15 window, from 10:00 left to the close, SHADOW's view is saved
 *      every 15s: the smart-money side, its share of the vote weight, how many wallets agree
 *      and disagree, the primary wallet's side, and the live Up/Down prices. The outcome is
 *      added at settlement. Skipped windows are logged too, so any rule can be replayed.
 *   2. Backtest. A rule (price band, entry time, agreement, primary-wallet mode, hours, side)
 *      is replayed over the log: the first snapshot that passes is the entry, paying the ask
 *      plus the taker fee, $10 a bet, held to the close.
 *   3. Proposals. The TUNER agent proposes rules (data, validated, never code). Each one is
 *      backtested on the whole log and tracked FORWARD on windows logged after it was made,
 *      the only numbers that can't have been fitted. PRISM retires losers.
 *   4. Champion. The applied proposal, or else the best proposal with FORWARD_MIN+ forward
 *      bets in profit. With no champion the TUNER searches broadly; with one it refines it:
 *      variations that change one or two settings, judged head-to-head against the champion
 *      on the same windows (both counted from the variation's creation).
 *   5. Lineup. Up to LINEUP_MAX proven rules run on SHADOW at once (each can cover different
 *      conditions: hours, side, how BTC is moving, how far it leads the start price). The
 *      first rule that fires takes the window, and every bet is tagged with its rule.
 *   6. Auto (LAB_AUTO, on by default): every 10 minutes, at most one change per 3 hours:
 *      a proven proposal joins the lineup when there's room, replaces the weakest member when
 *      it beats it on the same windows, and a member that turns into a loser is dropped.
 *      You can also add, remove or clear by hand (admin token). Rules need FORWARD_MIN
 *      forward bets in profit either way.
 *
 * No orders, no keys. Applying a proposal changes SHADOW's rule, which real money follows.
 */
import { takerFee } from "../fees.js";
import { saveJSON, loadJSON, pushLine, loadLines } from "./state.js";

const KEY_SIGNALS = "arena:shadowlab:signals", KEEP_WINDOWS = 3000;      // ~31 days of BTC15
const KEY_PROPOSALS = "arena:shadowlab:proposals", KEY_APPLIED = "arena:shadowlab:applied";
const SNAP_EVERY_MS = 15_000, SNAP_FROM_MS = 600_000, STAKE = 10;
export const LINEUP_MAX = Math.max(1, Math.min(5, Number(process.env.LAB_LINEUP_MAX || 3)));
const AUTO = () => process.env.LAB_AUTO !== "false";
const AUTO_COOLDOWN_MS = 3 * 3600_000, DROP_MIN = 30, SWAP_MARGIN = 2;
export const FORWARD_MIN = 20;          // forward bets before a proposal can be applied
const MAX_ACTIVE = 16;

// ── Rules ────────────────────────────────────────────────────────────
/** Allowed ranges. Everything outside is clamped or rejected, so an agent can't break SHADOW. */
const LIMITS = { minLeftSec: [15, 600], maxLeftSec: [30, 600], priceMin: [0.30, 0.95], priceMax: [0.35, 0.97],
  minShare: [0.5, 1], minAgree: [0, 15], maxAgainst: [0, 50],
  // What's going on in BTC (basis points): our side's lead over the window's start price
  // (negative = behind), and the size of BTC's move over the last 5 minutes.
  minLeadBps: [-300, 300], maxLeadBps: [-300, 300], moveMinBps: [0, 500], moveMaxBps: [0, 500] };
const FOLLOW = ["either", "consensus", "primary", "both"];
const SIDES = ["any", "up", "down"];

export function validateRule(r) {
  if (!r || typeof r !== "object") return { ok: false, error: "rule must be an object" };
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (r[k] == null) continue;
    const v = Number(r[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) return { ok: false, error: `${k} must be ${lo}-${hi}` };
    out[k] = v;
  }
  out.follow = r.follow ?? "either";
  if (!FOLLOW.includes(out.follow)) return { ok: false, error: `follow must be one of ${FOLLOW.join(", ")}` };
  out.side = r.side ?? "any";
  if (!SIDES.includes(out.side)) return { ok: false, error: `side must be one of ${SIDES.join(", ")}` };
  if (r.hoursUtc != null) {
    const h = r.hoursUtc;
    if (!Array.isArray(h) || h.length !== 2 || !h.every(x => Number.isInteger(x) && x >= 0 && x <= 24) || h[0] === h[1]) return { ok: false, error: "hoursUtc must be [start, end] whole hours 0-24, or null" };
    out.hoursUtc = h;
  } else out.hoursUtc = null;
  out.priceMin ??= 0.56; out.priceMax ??= 0.72; out.minLeftSec ??= 30; out.maxLeftSec ??= 270; out.minShare ??= 0.85; out.minAgree ??= 2;
  if (out.priceMin >= out.priceMax) return { ok: false, error: "priceMin must be under priceMax" };
  if (out.minLeftSec >= out.maxLeftSec) return { ok: false, error: "minLeftSec must be under maxLeftSec" };
  if (out.minLeadBps != null && out.maxLeadBps != null && out.minLeadBps >= out.maxLeadBps) return { ok: false, error: "minLeadBps must be under maxLeadBps" };
  if (out.moveMinBps != null && out.moveMaxBps != null && out.moveMinBps >= out.moveMaxBps) return { ok: false, error: "moveMinBps must be under moveMaxBps" };
  return { ok: true, rule: out };
}

const inHours = (h, hrs) => !hrs || (hrs[0] < hrs[1] ? h >= hrs[0] && h < hrs[1] : h >= hrs[0] || h < hrs[1]);
const pct = x => `${Math.round(x * 100)}`;
export function describeRule(r) {
  const f = { either: "primary wallet if it bet, else smart money", consensus: "smart money only", primary: "primary wallet only", both: "only when primary and smart money agree" }[r.follow];
  return [`${pct(r.priceMin)}-${pct(r.priceMax)}¢`, `${Math.floor(r.maxLeftSec / 60)}:${String(r.maxLeftSec % 60).padStart(2, "0")}-${Math.floor(r.minLeftSec / 60)}:${String(r.minLeftSec % 60).padStart(2, "0")} left`,
    `${pct(r.minShare)}%+ share`, `${r.minAgree}+ wallets`, r.maxAgainst != null ? `≤${r.maxAgainst} against` : null, f,
    r.side !== "any" ? `${r.side} only` : null, r.hoursUtc ? `${r.hoursUtc[0]}-${r.hoursUtc[1]} UTC` : null,
    r.minLeadBps != null || r.maxLeadBps != null ? `our side ${r.minLeadBps != null ? `≥${r.minLeadBps}` : ""}${r.minLeadBps != null && r.maxLeadBps != null ? " and " : ""}${r.maxLeadBps != null ? `≤${r.maxLeadBps}` : ""} bps vs the start price` : null,
    r.moveMinBps != null || r.moveMaxBps != null ? `BTC 5-min move ${r.moveMinBps ?? 0}-${r.moveMaxBps ?? "∞"} bps` : null].filter(Boolean).join(" · ");
}

/**
 * What the rule does in one snapshot: the side it would buy and the price, or null.
 * snap: { left, up, down, cSide, share, agree, against, pSide, lead, move }  (up/down = ask for
 * each side; lead = BTC vs the start price in bps, Up's view; move = |5-min BTC move| in bps)
 */
export function ruleEntry(r, s, startMs) {
  if (s.left < r.minLeftSec || s.left > r.maxLeftSec) return null;
  if (r.hoursUtc && !inHours(new Date(startMs).getUTCHours(), r.hoursUtc)) return null;
  let side = null, share = s.share, agree = s.agree, against = s.against;
  const pSide = s.pSide || null, cSide = s.cSide || null;
  if (r.follow === "consensus") side = cSide;
  else if (r.follow === "primary") side = pSide;
  else if (r.follow === "both") side = pSide && pSide === cSide ? pSide : null;
  else side = pSide || cSide;
  if (!side) return null;
  if (side !== cSide) {   // following the primary against (or without) the vote: the vote's numbers flip
    share = cSide ? +(1 - s.share).toFixed(4) : 1; agree = cSide ? s.against : 0; against = cSide ? s.agree : 0;
  }
  if (share < r.minShare) return null;
  if (!(side === pSide && r.follow !== "consensus") && agree < r.minAgree) return null;   // the primary needs no co-signers
  if (r.maxAgainst != null && against > r.maxAgainst) return null;
  if (r.side !== "any" && side.toLowerCase() !== r.side) return null;
  const px = side === "Up" ? s.up : s.down;
  if (px == null || px < r.priceMin || px > r.priceMax) return null;
  if (!marketOk(r, side, s.lead, s.move)) return null;
  return { side, px };
}

/** The rule's BTC conditions (lead over the start price, recent move). Missing data fails a set condition. */
export function marketOk(r, side, lead, move) {
  if (r.minLeadBps != null || r.maxLeadBps != null) {
    if (lead == null) return false;
    const mine = side === "Up" ? lead : -lead;
    if (r.minLeadBps != null && mine < r.minLeadBps) return false;
    if (r.maxLeadBps != null && mine > r.maxLeadBps) return false;
  }
  if (r.moveMinBps != null || r.moveMaxBps != null) {
    if (move == null) return false;
    if (r.moveMinBps != null && move < r.moveMinBps) return false;
    if (r.moveMaxBps != null && move > r.moveMaxBps) return false;
  }
  return true;
}
/** BTC's lead over the start price and its 5-minute move, in bps, from spot ticks [[t, price]]. */
export function marketState({ spot, strike, pxs }, now = Date.now()) {
  const lead = spot > 0 && strike > 0 ? +((spot - strike) / strike * 1e4).toFixed(1) : null;
  let move = null;
  if (spot > 0 && Array.isArray(pxs) && pxs.length) {
    const old = [...pxs].reverse().find(([t]) => t <= now - 5 * 60_000) || pxs[0];
    if (old && now - old[0] >= 3 * 60_000) move = +Math.abs((spot - old[1]) / old[1] * 1e4).toFixed(1);
  }
  return { lead, move };
}

const betPnl = (px, won) => { const n = STAKE / px, fee = takerFee(n, px); return +((won ? n : 0) - STAKE - fee).toFixed(4); };

/** Replay a rule over logged windows. Windows without an outcome are skipped. */
export function backtest(rule, windows, { since = 0 } = {}) {
  const bets = [];
  for (const w of windows) {
    if (w.outcome == null || w.start < since) continue;
    for (const s of w.snaps) {
      const e = ruleEntry(rule, s, w.start);
      if (!e) continue;
      const won = (w.outcome === 1) === (e.side === "Up");
      bets.push({ start: w.start, side: e.side, px: e.px, left: s.left, won, pnl: betPnl(e.px, won) });
      break;
    }
  }
  return { ...statsOf(bets), bets };
}

export function statsOf(bets) {
  const n = bets.length;
  if (!n) return { n: 0, windows: 0, wins: 0, winRate: null, perBet: null, total: 0, lcb: null, ucb: null, avgPx: null, firstHalf: null, secondHalf: null };
  const pnl = bets.map(b => b.pnl), mean = pnl.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(pnl.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const half = Math.floor(n / 2), avg = a => (a.length ? +(a.reduce((x, y) => x + y.pnl, 0) / a.length).toFixed(3) : null);
  const wins = bets.filter(b => b.won).length;
  return { n, wins, winRate: +(wins / n).toFixed(3), perBet: +mean.toFixed(3), total: +(mean * n).toFixed(2),
    lcb: n > 1 ? +(mean - 1.96 * sd / Math.sqrt(n)).toFixed(3) : null, ucb: n > 1 ? +(mean + 1.96 * sd / Math.sqrt(n)).toFixed(3) : null,
    avgPx: +(bets.reduce((a, b) => a + b.px, 0) / n).toFixed(3), firstHalf: avg(bets.slice(0, half)), secondHalf: avg(bets.slice(half)) };
}

/**
 * What moving each setting one step does, holding the rest: the table the TUNER reads.
 * Cheap: a few dozen backtests over at most a few thousand windows.
 */
export function sensitivity(base, windows) {
  const tries = [
    ["priceMin", [0.50, 0.53, 0.56, 0.60, 0.64]], ["priceMax", [0.66, 0.72, 0.78, 0.85, 0.92]],
    ["maxLeftSec", [120, 180, 270, 360, 480, 600]], ["minLeftSec", [15, 30, 60, 90]],
    ["minShare", [0.6, 0.75, 0.85, 0.95, 1]], ["minAgree", [0, 1, 2, 3, 5, 8]],
    ["follow", FOLLOW], ["side", SIDES], ["hoursUtc", [null, [0, 12], [12, 24], [0, 6], [6, 12], [12, 18], [18, 24]]],
    ["minLeadBps", [null, -20, 0, 10, 25, 50]], ["maxLeadBps", [null, 0, 25, 50, 100]], ["moveMinBps", [null, 5, 15, 30]], ["moveMaxBps", [null, 10, 20, 40]],
  ];
  const out = {};
  for (const [k, vals] of tries) {
    out[k] = vals.map(v => {
      const v2 = validateRule({ ...base, [k]: v });
      if (!v2.ok) return null;
      const b = backtest(v2.rule, windows);
      return { value: v, n: b.n, winRate: b.winRate, perBet: b.perBet, lcb: b.lcb };
    }).filter(Boolean);
  }
  return out;
}

// ── Runtime: logging snapshots ───────────────────────────────────────
const state = { cur: null, windows: [], proposals: [], lineup: [], lastAutoAt: 0, autoLog: [], loaded: false, logged: 0 };
let liveByRule = () => ({});     // SHADOW registers: real-money results per rule id

/**
 * Called by SHADOW on every poll / fast tick with what it sees now. Saves at most one
 * snapshot per 15s per window, only in the last 10 minutes.
 */
export function observe({ slug, start, end, now, up, down, consensus, pSide, lead = null, move = null }) {
  if (!slug || end - now > SNAP_FROM_MS || now >= end) return;
  let w = state.cur;
  if (!w || w.slug !== slug) { w = state.cur = { slug, start, end, snaps: [], lastAt: 0 }; }
  if (now - w.lastAt < SNAP_EVERY_MS) return;
  w.lastAt = now;
  const c = consensus || {};
  w.snaps.push({ left: Math.round((end - now) / 1000), up: up ?? null, down: down ?? null, cSide: c.side || null, share: c.share ?? 0,
    agree: c.agree ?? 0, against: c.against ?? 0, pSide: pSide || null, lead, move });
}

/** Window settled: attach the outcome and save it to the log. */
export async function settle(rec) {
  const w = state.cur;
  if (!w || w.slug !== rec.slug) return;
  state.cur = null;
  if (!w.snaps.length) return;
  const row = { slug: w.slug, start: w.start, end: w.end, outcome: rec.outcome ?? null, snaps: w.snaps };
  state.windows.push(row);
  if (state.windows.length > KEEP_WINDOWS) state.windows.shift();
  state.logged++;
  await pushLine(KEY_SIGNALS, row, KEEP_WINDOWS);
}

export async function loadLab() {
  if (state.loaded) return;
  state.loaded = true;
  state.windows = (await loadLines(KEY_SIGNALS)).filter(w => Array.isArray(w?.snaps));
  state.proposals = (await loadJSON(KEY_PROPOSALS)) || [];
  const a = await loadJSON(KEY_APPLIED);
  // v1 saved one applied rule; v2 saves { lineup, lastAutoAt, autoLog }.
  if (a?.lineup) { state.lineup = a.lineup; state.lastAutoAt = a.lastAutoAt || 0; state.autoLog = a.autoLog || []; }
  else if (a?.id) state.lineup = [{ id: a.id, rule: a.rule, at: a.at, by: "you" }];
}
export const labWindows = () => state.windows;
export const lineup = () => state.lineup;
export const appliedRule = () => state.lineup[0] || null;
export function setLiveSource(fn) { liveByRule = fn; }
const saveLineup = () => saveJSON(KEY_APPLIED, { lineup: state.lineup, lastAutoAt: state.lastAutoAt, autoLog: state.autoLog.slice(-30) });

// ── Proposals ────────────────────────────────────────────────────────
const slugify = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export async function addProposal({ name, rule, rationale, author, parent = null }, now = Date.now()) {
  const v = validateRule(rule);
  if (!v.ok) return { ok: false, error: v.error };
  const id = slugify(name) || `p-${now}`;
  if (state.proposals.some(p => p.id === id)) return { ok: false, error: `name ${id} already used` };
  if (state.proposals.filter(p => p.status === "active").length >= MAX_ACTIVE) return { ok: false, error: `${MAX_ACTIVE} active proposals already` };
  const same = state.proposals.find(p => p.status === "active" && JSON.stringify(p.rule) === JSON.stringify(v.rule));
  if (same) return { ok: false, error: `same rule as ${same.id}` };
  const p = { id, rule: v.rule, rationale: String(rationale || "").slice(0, 300), author: author || "you", createdAt: now, status: "active",
    parent: parent && state.proposals.some(x => x.id === parent) ? parent : null };
  state.proposals.push(p);
  await saveJSON(KEY_PROPOSALS, state.proposals);
  return { ok: true, proposal: p };
}

export function scoreProposal(p, windows = state.windows) {
  const all = backtest(p.rule, windows), fwd = backtest(p.rule, windows, { since: p.createdAt });
  const { bets: _a, ...allS } = all, { bets: _f, ...fwdS } = fwd;
  const canApply = fwd.n >= FORWARD_MIN && fwd.perBet > 0;
  // A refinement is judged against its parent on the same windows (both from its creation).
  const par = p.parent && state.proposals.find(x => x.id === p.parent);
  let vsParent = null;
  if (par) {
    const pf = backtest(par.rule, windows, { since: p.createdAt });
    vsParent = { parent: par.id, n: fwd.n, perBet: fwd.perBet, total: fwd.total, parentN: pf.n, parentPerBet: pf.perBet, parentTotal: pf.total,
      better: fwd.n >= FORWARD_MIN && pf.n > 0 && fwd.total > pf.total };
  }
  return { ...p, text: describeRule(p.rule), backtest: allS, forward: fwdS, canApply, vsParent,
    applyWhy: canApply ? null : fwd.n < FORWARD_MIN ? `needs ${FORWARD_MIN - fwd.n} more forward bets` : "losing on forward bets" };
}

/** PRISM's rule: 40+ forward bets and even the optimistic end of the range loses. */
export async function pruneProposals(log = () => {}) {
  let n = 0;
  for (const p of state.proposals.filter(x => x.status === "active")) {
    const f = backtest(p.rule, state.windows, { since: p.createdAt });
    if (f.n >= 40 && f.ucb != null && f.ucb < 0) { p.status = "retired"; p.retiredWhy = `losing: ${f.n} forward bets, best case ${f.ucb}/bet`; n++; log("PRISM", `retired SHADOW proposal ${p.id}: ${p.retiredWhy}`); }
  }
  if (n) await saveJSON(KEY_PROPOSALS, state.proposals);
  return n;
}

/** Add a proven proposal to the lineup (by hand or auto). A full lineup drops its weakest member. */
export async function applyProposal(id, now = Date.now(), by = "you") {
  const p = state.proposals.find(x => x.id === id);
  if (!p) return { ok: false, error: "no such proposal" };
  if (state.lineup.some(l => l.id === id)) return { ok: false, error: "already in the lineup" };
  const s = scoreProposal(p);
  if (!s.canApply) return { ok: false, error: `not yet: ${s.applyWhy}` };
  let dropped = null;
  if (state.lineup.length >= LINEUP_MAX) { dropped = weakest(); state.lineup = state.lineup.filter(l => l.id !== dropped.id); }
  state.lineup.push({ id, rule: p.rule, at: now, by });
  note(now, `${by === "auto" ? "AUTO: " : ""}added ${id} to the lineup${dropped ? `, replacing ${dropped.id}` : ""} (${s.forward.n} forward bets, ${s.forward.perBet >= 0 ? "+" : ""}${s.forward.perBet}/bet)`);
  await saveLineup();
  return { ok: true, applied: state.lineup.at(-1), dropped: dropped?.id || null, lineup: state.lineup };
}
export async function removeFromLineup(id, now = Date.now(), why = "removed by you") {
  if (!state.lineup.some(l => l.id === id)) return { ok: false, error: "not in the lineup" };
  state.lineup = state.lineup.filter(l => l.id !== id);
  note(now, `${id} left the lineup: ${why}`);
  await saveLineup();
  return { ok: true, lineup: state.lineup };
}
export async function revertApplied(now = Date.now()) { state.lineup = []; note(now, "lineup cleared: SHADOW back on its original rule"); await saveLineup(); return { ok: true }; }
function note(t, msg) { state.autoLog.push({ t, msg }); if (state.autoLog.length > 30) state.autoLog.shift(); }

/** A lineup member's record since it joined: the replay on windows since then plus its real bets. */
export function memberScore(l, windows = state.windows) {
  const { bets, ...since } = backtest(l.rule, windows, { since: l.at });
  return { ...l, text: describeRule(l.rule), since, live: liveByRule()?.[l.id] || null };
}
function weakest() { return state.lineup.map(l => memberScore(l)).sort((a, b) => (a.since.total ?? 0) - (b.since.total ?? 0))[0]; }

/**
 * Auto mode: keep the lineup made of winners. At most one change per AUTO_COOLDOWN_MS.
 *   drop: a member with DROP_MIN+ replayed bets since it joined and a negative average, or
 *         20+ real bets losing money while its replay isn't winning;
 *   add:  the best proven proposal (FORWARD_MIN+ forward bets in profit, replay in profit too)
 *         when there's room;
 *   swap: when full, that proposal replaces the weakest member if it made SWAP_MARGIN ($ per
 *         $10 bets) more than the weakest on the same windows.
 * Returns { changed, msg }.
 */
export async function autoManage(now = Date.now(), log = () => {}) {
  if (!AUTO() || now - state.lastAutoAt < AUTO_COOLDOWN_MS) return { changed: false };
  const done = async (msg) => { state.lastAutoAt = now; await saveLineup(); log("AUTO", msg); return { changed: true, msg }; };
  for (const l of state.lineup.map(x => memberScore(x))) {
    const liveBad = l.live && l.live.n >= 20 && l.live.pnl < 0 && !(l.since.perBet > 0);
    if ((l.since.n >= DROP_MIN && l.since.perBet < 0) || liveBad) {
      await removeFromLineup(l.id, now, `AUTO: losing (${l.since.n} bets since it joined, ${l.since.perBet}/bet${l.live ? `; real ${l.live.n} bets, ${l.live.pnl >= 0 ? "+" : ""}$${l.live.pnl}` : ""})`);
      return done(`dropped ${l.id}: losing`);
    }
  }
  const inL = new Set(state.lineup.map(l => l.id));
  const cands = state.proposals.filter(p => p.status === "active" && !inL.has(p.id)).map(p => scoreProposal(p))
    .filter(p => p.canApply && p.backtest.perBet > 0).sort((a, b) => (b.forward.lcb ?? -99) - (a.forward.lcb ?? -99) || b.forward.total - a.forward.total);
  const best = cands[0];
  if (!best) return { changed: false };
  if (state.lineup.length < LINEUP_MAX) { await applyProposal(best.id, now, "auto"); return done(`added ${best.id}`); }
  const w = weakest(), wSame = backtest(w.rule, state.windows, { since: best.createdAt });
  if (best.forward.total > (wSame.total ?? 0) + SWAP_MARGIN) { await applyProposal(best.id, now, "auto"); return done(`swapped ${w.id} for ${best.id}`); }
  return { changed: false };
}

/**
 * The strategy the agents are refining: the applied proposal, else the active proposal with
 * FORWARD_MIN+ forward bets in profit and the best forward low-end estimate. null = keep searching.
 */
export function champion(windows = state.windows) {
  if (state.lineup.length) {
    // The lineup member making the most since it joined.
    const top = state.lineup.map(l => memberScore(l, windows)).sort((a, b) => (b.since.total ?? 0) - (a.since.total ?? 0))[0];
    const p = state.proposals.find(x => x.id === top.id);
    if (p) return scoreProposal(p, windows);
  }
  const ok = state.proposals.filter(p => p.status === "active").map(p => scoreProposal(p, windows)).filter(p => p.canApply);
  ok.sort((a, b) => (b.forward.lcb ?? -99) - (a.forward.lcb ?? -99) || b.forward.total - a.forward.total);
  return ok[0] || null;
}

export function labStatus(currentRule) {
  const windows = state.windows, settled = windows.filter(w => w.outcome != null).length;
  const cur = currentRule ? (() => { const { bets, ...s } = backtest(currentRule, windows); return { text: describeRule(currentRule), ...s }; })() : null;
  const champ = champion(windows);
  return { windows: windows.length, settled, forwardMin: FORWARD_MIN, current: cur, applied: state.lineup[0] || null,
    lineup: state.lineup.map(l => memberScore(l, windows)), lineupMax: LINEUP_MAX, auto: AUTO(), autoLog: state.autoLog.slice(-10).reverse(),
    mode: champ ? "refine" : "search", champion: champ ? champ.id : null,
    proposals: state.proposals.map(p => scoreProposal(p, windows)).sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || (b.forward.lcb ?? -99) - (a.forward.lcb ?? -99) || (b.backtest.lcb ?? -99) - (a.backtest.lcb ?? -99)) };
}

// Tests.
export function _reset() { state.cur = null; state.windows = []; state.proposals = []; state.lineup = []; state.lastAutoAt = 0; state.autoLog = []; state.loaded = true; }
export function _push(w) { state.windows.push(w); }
