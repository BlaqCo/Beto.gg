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
 *   5. Apply. Only a person can apply a proposal to SHADOW (admin token), and only once it
 *      has FORWARD_MIN forward bets and is profitable on them.
 *
 * No orders, no keys. Applying a proposal changes SHADOW's rule, which real money follows.
 */
import { takerFee } from "../fees.js";
import { saveJSON, loadJSON, pushLine, loadLines } from "./state.js";

const KEY_SIGNALS = "arena:shadowlab:signals", KEEP_WINDOWS = 3000;      // ~31 days of BTC15
const KEY_PROPOSALS = "arena:shadowlab:proposals", KEY_APPLIED = "arena:shadowlab:applied";
const SNAP_EVERY_MS = 15_000, SNAP_FROM_MS = 600_000, STAKE = 10;
export const FORWARD_MIN = 20;          // forward bets before a proposal can be applied
const MAX_ACTIVE = 16;

// ── Rules ────────────────────────────────────────────────────────────
/** Allowed ranges. Everything outside is clamped or rejected, so an agent can't break SHADOW. */
const LIMITS = { minLeftSec: [15, 600], maxLeftSec: [30, 600], priceMin: [0.30, 0.95], priceMax: [0.35, 0.97],
  minShare: [0.5, 1], minAgree: [0, 15], maxAgainst: [0, 50] };
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
  return { ok: true, rule: out };
}

const inHours = (h, hrs) => !hrs || (hrs[0] < hrs[1] ? h >= hrs[0] && h < hrs[1] : h >= hrs[0] || h < hrs[1]);
const pct = x => `${Math.round(x * 100)}`;
export function describeRule(r) {
  const f = { either: "primary wallet if it bet, else smart money", consensus: "smart money only", primary: "primary wallet only", both: "only when primary and smart money agree" }[r.follow];
  return [`${pct(r.priceMin)}-${pct(r.priceMax)}¢`, `${Math.floor(r.maxLeftSec / 60)}:${String(r.maxLeftSec % 60).padStart(2, "0")}-${Math.floor(r.minLeftSec / 60)}:${String(r.minLeftSec % 60).padStart(2, "0")} left`,
    `${pct(r.minShare)}%+ share`, `${r.minAgree}+ wallets`, r.maxAgainst != null ? `≤${r.maxAgainst} against` : null, f,
    r.side !== "any" ? `${r.side} only` : null, r.hoursUtc ? `${r.hoursUtc[0]}-${r.hoursUtc[1]} UTC` : null].filter(Boolean).join(" · ");
}

/**
 * What the rule does in one snapshot: the side it would buy and the price, or null.
 * snap: { left, up, down, cSide, share, agree, against, pSide }  (up/down = ask for each side)
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
  return { side, px };
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
const state = { cur: null, windows: [], proposals: [], applied: null, loaded: false, logged: 0 };

/**
 * Called by SHADOW on every poll / fast tick with what it sees now. Saves at most one
 * snapshot per 15s per window, only in the last 10 minutes.
 */
export function observe({ slug, start, end, now, up, down, consensus, pSide }) {
  if (!slug || end - now > SNAP_FROM_MS || now >= end) return;
  let w = state.cur;
  if (!w || w.slug !== slug) { w = state.cur = { slug, start, end, snaps: [], lastAt: 0 }; }
  if (now - w.lastAt < SNAP_EVERY_MS) return;
  w.lastAt = now;
  const c = consensus || {};
  w.snaps.push({ left: Math.round((end - now) / 1000), up: up ?? null, down: down ?? null, cSide: c.side || null, share: c.share ?? 0,
    agree: c.agree ?? 0, against: c.against ?? 0, pSide: pSide || null });
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
  state.applied = (await loadJSON(KEY_APPLIED)) || null;
}
export const labWindows = () => state.windows;
export const appliedRule = () => state.applied;

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

export async function applyProposal(id, now = Date.now()) {
  const p = state.proposals.find(x => x.id === id);
  if (!p) return { ok: false, error: "no such proposal" };
  const s = scoreProposal(p);
  if (!s.canApply) return { ok: false, error: `not yet: ${s.applyWhy}` };
  state.applied = { id, rule: p.rule, at: now, forward: s.forward };
  await saveJSON(KEY_APPLIED, state.applied);
  return { ok: true, applied: state.applied };
}
export async function revertApplied() { state.applied = null; await saveJSON(KEY_APPLIED, null); return { ok: true }; }

/**
 * The strategy the agents are refining: the applied proposal, else the active proposal with
 * FORWARD_MIN+ forward bets in profit and the best forward low-end estimate. null = keep searching.
 */
export function champion(windows = state.windows) {
  if (state.applied?.id) {
    const p = state.proposals.find(x => x.id === state.applied.id);
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
  return { windows: windows.length, settled, forwardMin: FORWARD_MIN, current: cur, applied: state.applied,
    mode: champ ? "refine" : "search", champion: champ ? champ.id : null,
    proposals: state.proposals.map(p => scoreProposal(p, windows)).sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || (b.forward.lcb ?? -99) - (a.forward.lcb ?? -99) || (b.backtest.lcb ?? -99) - (a.backtest.lcb ?? -99)) };
}

// Tests.
export function _reset() { state.cur = null; state.windows = []; state.proposals = []; state.applied = null; state.loaded = true; }
export function _push(w) { state.windows.push(w); }
