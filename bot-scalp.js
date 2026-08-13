/**
 * bot-scalp.js — SCALP LAB (paper only, fully isolated)
 *
 * Tests the mean-reversion idea: when a live favourite gets dumped after a
 * bad point/round, does it bounce back enough to scalp?
 *
 * ISOLATION GUARANTEES — this module:
 *   • never imports or calls any order function (no buyYesFOK, no buyYesMaker,
 *     no closePositionLive). It physically cannot place a trade.
 *   • keeps its own in-memory ledger; it never touches state.js.
 *   • uses its own config constants; it never reads or writes the live
 *     bot's config keys.
 *   • only runs when SCALP_PAPER=true is set in the environment.
 *   • reuses the shared 20s-cached market list and fetches quotes only for
 *     the handful of markets it is tracking, so it adds almost no API load.
 *
 * Its whole job is to answer one question with data: how often does a dip
 * bounce, and by how much?
 */

import * as pm from "./polymarket-us.js";

// ── settings ─────────────────────────────────────────────────────
export const SCALP = {
  ENABLED:     process.env.SCALP_PAPER === "true",
  SCAN_MS:     20_000,   // own cadence, offset from the live bot
  TRACK_MAX:   30,       // markets quoted per cycle (API-friendly)

  // ── STRATEGY MODE ──────────────────────────────────────────────
  // "revert"   — buy dips expecting a bounce.  TESTED: 41.9% over 93 trades
  //              against a 68.9% break-even. Comprehensively disproven.
  // "momentum" — the inverse, which the same data supports: 51 of 93 moves
  //              CONTINUED. Buy strength, not weakness.
  //
  // "event" — NEW, and the only one the data supports. The latency lab found
  //           297 score/period events: 78% repriced, median 17.1s later, 7¢
  //           average move. So a score change is a genuine information signal
  //           with a ~17s window. We wait for the price to CONFIRM direction
  //           (it must tick up, since we can only go long), then ride the rest.
  MODE:        "event",

  EV_WINDOW_MS:  25_000,   // an event stays actionable this long
  EV_CONFIRM:    0.015,    // price must move ≥1.5¢ in our favour first
  EV_MAX_CHASE:  0.045,    // ...but don't enter if it already ran >4.5¢
  TAKE_EV:       0.05,     // +5¢  → break-even 52.5%
  STOP_EV:       0.03,     // −3¢
  EV_HOLD_MS:    120_000,  // the move completes in ~17s; 2 min is generous

  // Only these leagues. Round-based esports overshoot most reliably.
  // Empty array = every live market.
  LEAGUES:     ["CS2", "CSGO", "COUNTER-STRIKE", "VALORANT", "LOL", "LEAGUE-OF-LEGENDS", "LCK", "LEC", "LPL", "LCS"],

  PX_MIN:      0.35,     // wider zone = more candidates
  PX_MAX:      0.85,
  DIP_MIN:     0.06,     // revert mode: dip size that triggers a buy
  RISE_MIN:    0.05,     // momentum mode: rise from the recent low that triggers
  // Momentum wants the opposite exit shape from mean reversion: let the move
  // run, cut fast. With fees, +7¢/−4¢ needs ~45% — beatable if continuation
  // really is the 58% side.
  TAKE_MOM:    0.07,
  STOP_MOM:    0.04,
  DIP_WINDOW:  10 * 60_000, // loosened from 6 min

  BANKROLL:    500,      // paper starting balance
  STAKE:       70,       // paper dollars per scalp
  // Risk/reward must respect the observed bounce rate: break-even is
  // stop/(stop+take), so a 4¢/5¢ pair needs ~56% — under the 61% seen so far.
  // The old 3¢/8¢ pair needed 73% and could never work.
  TAKE:        0.04,     // exit +4¢
  STOP:        0.05,     // exit −5¢
  MAX_SPREAD:  0.05,     // loosened from 3¢
  MAX_HOLD_MS: 20 * 60_000,
  MAX_OPEN:    5,
  COOLDOWN_MS: 60_000,   // brief pause before re-entering the SAME market

  FEE_COEF:    0.03,     // entry assumed maker (free); exit pays taker
};

const feeFor = (px, usd) => SCALP.FEE_COEF * (usd / Math.max(px, 0.01)) * Math.min(px, 1 - px);

// ── isolated state ───────────────────────────────────────────────
const high   = new Map();  // slug → { px, ts }
const low    = new Map();  // slug → { px, ts }  (momentum baseline)
const cooldown = new Map();  // slug → timestamp we last exited it
const evState  = new Map();  // slug → { score, period, px }
const evArmed  = new Map();  // slug → { at, pxAtEvent, note }
const reEntries = new Map(); // slug → how many times we've traded it
const open   = new Map();  // slug → paper position
const closed = [];         // completed paper scalps
let cycles = 0, lastRun = 0, running = false, peakPnl = 0;

export function scalpStats() {
  const staked = [...open.values()].reduce((a, p) => a + p.stake, 0);
  const wins = closed.filter(t => t.pnl > 0).length;
  const bounced = closed.filter(t => t.reason === "bounce").length;
  const pnl = closed.reduce((a, t) => a + t.pnl, 0);
  const dips = closed.map(t => t.maxBounce).filter(x => x != null);
  return {
    enabled: SCALP.ENABLED, cycles, lastRun,
    openCount: open.size, tracked: high.size,
    trades: closed.length, wins, losses: closed.length - wins,
    bounceRate: closed.length ? +(bounced / closed.length * 100).toFixed(1) : null,
    winRate: closed.length ? +(wins / closed.length * 100).toFixed(1) : null,
    pnl: +pnl.toFixed(2),
    bankrollStart: SCALP.BANKROLL,
    equity: +(SCALP.BANKROLL + pnl).toFixed(2),
    exposure: +staked.toFixed(2),
    peak: +(SCALP.BANKROLL + peakPnl).toFixed(2),
    drawdown: +((SCALP.BANKROLL + pnl) - (SCALP.BANKROLL + peakPnl)).toFixed(2),
    roiPct: +((pnl / SCALP.BANKROLL) * 100).toFixed(2),
    avgHoldMin: closed.length ? +(closed.reduce((a, t) => a + (t.heldMin || 0), 0) / closed.length).toFixed(1) : null,
    exits: {
      bounce:  closed.filter(t => t.reason === "bounce").length,
      break:   closed.filter(t => t.reason === "break").length,
      timeout: closed.filter(t => t.reason === "timeout").length,
    },
    avgBounce: dips.length ? +(dips.reduce((a, b) => a + b, 0) / dips.length * 100).toFixed(2) : null,
    mode: SCALP.MODE,
    breakEvenNeeded: (() => {
      const px = 0.60;
      const take = SCALP.MODE === "event" ? SCALP.TAKE_EV : SCALP.MODE === "momentum" ? SCALP.TAKE_MOM : SCALP.TAKE;
      const stop = SCALP.MODE === "event" ? SCALP.STOP_EV : SCALP.MODE === "momentum" ? SCALP.STOP_MOM : SCALP.STOP;
      const win = SCALP.STAKE * (take / px) - feeFor(px, SCALP.STAKE);
      const loss = SCALP.STAKE * (stop / px) + feeFor(px, SCALP.STAKE);
      return +(loss / (win + loss) * 100).toFixed(1);
    })(),
    // Excursion data — how far trades actually run in each direction.
    // This is what tells us the right take/stop next time.
    avgMaxFavourable: (() => { const a = closed.map(t => t.maxBounce).filter(x => x != null);
      return a.length ? +(a.reduce((x, y) => x + y, 0) / a.length * 100).toFixed(2) : null; })(),
    avgMaxAdverse: (() => { const a = closed.map(t => t.maxAdverse).filter(x => x != null);
      return a.length ? +(a.reduce((x, y) => x + y, 0) / a.length * 100).toFixed(2) : null; })(),
    repeatMarkets: [...reEntries.entries()].filter(([, n]) => n > 1).length,
    maxTradesOneMarket: reEntries.size ? Math.max(...reEntries.values()) : 0,
    byLeague: Object.values(closed.reduce((acc, t) => {
      const k = t.league || "OTHER";
      (acc[k] ||= { league: k, n: 0, bounce: 0, pnl: 0 });
      acc[k].n++; if (t.reason === "bounce") acc[k].bounce++;
      acc[k].pnl = +(acc[k].pnl + t.pnl).toFixed(2);
      return acc;
    }, {})).map(x => ({ ...x, rate: +(x.bounce / x.n * 100).toFixed(0) })),
    recent: closed.slice(-12).reverse(),
    settings: SCALP,
  };
}

// ── one cycle ────────────────────────────────────────────────────
export async function runScalpCycle() {
  if (!SCALP.ENABLED || running) return;
  running = true;
  try {
    if (Date.now() - lastRun < SCALP.SCAN_MS) return;
    lastRun = Date.now(); cycles++;

    const markets = await pm.fetchSportsMoneylines();   // shared 20s cache
    const inLeague = m => {
      if (!SCALP.LEAGUES.length) return true;
      const hay = `${m.league || ""} ${m.slug || ""} ${m.question || ""}`.toUpperCase();
      return SCALP.LEAGUES.some(t => hay.includes(t));
    };
    const live = markets.filter(m => m.isLive && inLeague(m));
    if (cycles % 10 === 1) {
      const total = markets.filter(m => m.isLive).length;
      console.log(`🧪 Scalp lab watching ${live.length}/${total} live markets (${SCALP.LEAGUES.join("/") || "all"})`);
    }
    if (!live.length) return;

    // Quote the open positions first, then the most promising watch targets.
    const openSlugs = [...open.keys()];
    const watch = live
      .filter(m => !open.has(m.slug))
      .sort((a, b) => {
        const ha = high.get(a.slug)?.px ?? a.ask ?? 0;
        const hb = high.get(b.slug)?.px ?? b.ask ?? 0;
        return ((hb - (b.ask ?? hb)) - (ha - (a.ask ?? ha)));
      })
      .slice(0, Math.max(0, SCALP.TRACK_MAX - openSlugs.length))
      .map(m => m.slug);

    const bySlug = new Map(live.map(m => [m.slug, m]));
    const quotes = new Map();
    for (const slug of [...openSlugs, ...watch]) {
      const q = await pm.getBBO(slug).catch(() => null);
      if (q?.bid && q?.ask) quotes.set(slug, q);
      await new Promise(r => setTimeout(r, 60));         // gentle pacing
    }

    const now = Date.now();

    // 1) manage open paper positions
    for (const [slug, p] of [...open.entries()]) {
      const q = quotes.get(slug);
      if (!q) continue;
      const bid = q.bid;                                   // what we'd sell into
      p.maxBounce  = Math.max(p.maxBounce ?? 0, bid - p.entry);   // best excursion
      p.maxAdverse = Math.min(p.maxAdverse ?? 0, bid - p.entry);   // worst excursion
      p.minPx = Math.min(p.minPx ?? bid, bid);

      const take = p.mode === "event" ? SCALP.TAKE_EV : p.mode === "momentum" ? SCALP.TAKE_MOM : SCALP.TAKE;
      const stop = p.mode === "event" ? SCALP.STOP_EV : p.mode === "momentum" ? SCALP.STOP_MOM : SCALP.STOP;
      const hold = p.mode === "event" ? SCALP.EV_HOLD_MS : SCALP.MAX_HOLD_MS;
      let reason = null;
      if (bid >= p.entry + take)      reason = "bounce";
      else if (bid <= p.entry - stop) reason = "break";
      else if (now - p.ts >= hold)    reason = "timeout";
      if (!reason) continue;

      const shares = p.stake / p.entry;
      const gross  = shares * bid - p.stake;
      const fee    = feeFor(bid, shares * bid);            // exit is a taker sale
      const pnl    = +(gross - fee).toFixed(3);
      closed.push({ slug, q: p.q, league: p.league, mode: p.mode || SCALP.MODE,
                    entry: p.entry, exit: bid, reason, pnl,
                    heldMin: +((now - p.ts) / 60000).toFixed(1),
                    maxBounce: p.maxBounce, maxAdverse: p.maxAdverse,
                    evNote: p.evNote || null, evLagSec: p.evLagSec ?? null });
      open.delete(slug);
      // RE-ENTRY: re-baseline this market's high-water at the exit price and
      // restart its clock, so a fresh dip later is a fresh trade. Without this
      // the stale high timestamp aged out and the game was done for good.
      high.set(slug, { px: Math.max(bid, p.entry), ts: now });
      cooldown.set(slug, now);
      reEntries.set(slug, (reEntries.get(slug) || 0) + 1);
      const running_pnl = closed.reduce((a, t) => a + t.pnl, 0);
      if (running_pnl > peakPnl) peakPnl = running_pnl;
      console.log(`🧪 SCALP ${reason.toUpperCase()} ${Math.round(p.entry*100)}¢→${Math.round(bid*100)}¢ ` +
                  `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${p.q.slice(0, 34)}`);
    }

    // 2) look for new dips — never stake more paper money than the bankroll
    const exposure = [...open.values()].reduce((a, p) => a + p.stake, 0);
    for (const slug of watch) {
      if (open.size >= SCALP.MAX_OPEN) break;
      if (exposure + SCALP.STAKE > SCALP.BANKROLL + closed.reduce((a, t) => a + t.pnl, 0)) break;
      const q = quotes.get(slug); const m = bySlug.get(slug);
      if (!q || !m) continue;
      const ask = q.ask, bid = q.bid;
      if (!(ask > 0 && bid > 0 && ask > bid && ask - bid <= SCALP.MAX_SPREAD)) continue;

      const cd = cooldown.get(slug);
      if (cd && now - cd < SCALP.COOLDOWN_MS) continue;   // just exited — let it settle

      // ── EVENT MODE ────────────────────────────────────────────
      if (SCALP.MODE === "event") {
        const prevEv = evState.get(slug);
        const score = m.evScore ?? null, period = m.evPeriod ?? null;
        evState.set(slug, { score, period, px: ask });

        // 1) arm on a score/period change
        if (prevEv) {
          const changed = (score != null && prevEv.score != null && score !== prevEv.score)
                       || (period != null && prevEv.period != null && period !== prevEv.period);
          if (changed && !evArmed.has(slug)) {
            evArmed.set(slug, { at: now, pxAtEvent: prevEv.px,
                                note: score !== prevEv.score ? `score ${prevEv.score}→${score}` : `period ${prevEv.period}→${period}` });
            console.log(`🧪 ARMED: ${prevEv.score}→${score} @ ${Math.round(prevEv.px*100)}¢ | ${(m.question||slug).slice(0,32)}`);
          }
        }

        // 2) enter once the price confirms an upward move (we can only go long)
        const armed = evArmed.get(slug);
        if (armed) {
          const moved = ask - armed.pxAtEvent;
          if (now - armed.at > SCALP.EV_WINDOW_MS) { evArmed.delete(slug); continue; }
          if (moved >= SCALP.EV_CONFIRM && moved <= SCALP.EV_MAX_CHASE
              && ask >= SCALP.PX_MIN && ask <= SCALP.PX_MAX
              && (ask - bid) <= SCALP.MAX_SPREAD) {
            const lg3 = (SCALP.LEAGUES.find(t => `${m.slug} ${m.question}`.toUpperCase().includes(t)) || "OTHER");
            open.set(slug, { q: m.question || slug, league: lg3, entry: bid, stake: SCALP.STAKE,
                             ts: now, maxBounce: 0, maxAdverse: 0, minPx: bid, mode: "event",
                             evNote: armed.note, evLagSec: +((now - armed.at) / 1000).toFixed(1) });
            evArmed.delete(slug);
            console.log(`🧪 EVENT ENTRY (paper) ${Math.round(bid*100)}¢ | +${Math.round(moved*100)}¢ ` +
                        `${((now - armed.at)/1000).toFixed(0)}s after ${armed.note} | ${(m.question||slug).slice(0,30)}`);
          }
        }
        continue;
      }

      const l = low.get(slug);
      if (!l || ask < l.px) low.set(slug, { px: ask, ts: now });

      // ── MOMENTUM: buy continuation off a recent low ──
      if (SCALP.MODE === "momentum") {
        const base = low.get(slug);
        if (!base) continue;
        const rise = ask - base.px;
        const freshLow = now - base.ts <= SCALP.DIP_WINDOW;
        if (!freshLow || rise < SCALP.RISE_MIN) continue;
        if (ask < SCALP.PX_MIN || ask > SCALP.PX_MAX) continue;
        const lg2 = (SCALP.LEAGUES.find(t => `${m.slug} ${m.question}`.toUpperCase().includes(t)) || "OTHER");
        open.set(slug, { q: m.question || slug, league: lg2, entry: bid, stake: SCALP.STAKE,
                         ts: now, maxBounce: 0, maxAdverse: 0, minPx: bid, high: ask, mode: "momentum" });
        low.set(slug, { px: ask, ts: now });     // re-baseline so it doesn't retrigger
        const n2 = (reEntries.get(slug) || 0) + 1;
        console.log(`🧪 MOMENTUM ENTRY (paper) ${Math.round(bid*100)}¢ after +${Math.round(rise*100)}¢ ` +
                    `off ${Math.round(base.px*100)}¢${n2 > 1 ? ` [#${n2}]` : ""} | ${(m.question || slug).slice(0, 32)}`);
        continue;
      }

      const h = high.get(slug);
      if (!h || ask > h.px) { high.set(slug, { px: ask, ts: now }); continue; }
      // Price is back near its high → restart the freshness clock so the
      // market stays tradeable instead of ageing out permanently.
      if (ask >= h.px - 0.01) { high.set(slug, { px: h.px, ts: now }); continue; }

      const dip = h.px - ask;
      const fresh = now - h.ts <= SCALP.DIP_WINDOW;
      if (!fresh || dip < SCALP.DIP_MIN) continue;
      if (ask < SCALP.PX_MIN || ask > SCALP.PX_MAX) continue;

      // PAPER ENTRY — assumes a maker fill at the bid, so no entry fee.
      const lg = (SCALP.LEAGUES.find(t => `${m.slug} ${m.question}`.toUpperCase().includes(t)) || "OTHER");
      open.set(slug, { q: m.question || slug, league: lg, entry: bid, stake: SCALP.STAKE,
                       ts: now, maxBounce: 0, minPx: bid, high: h.px });
      const n = (reEntries.get(slug) || 0) + 1;
      console.log(`🧪 SCALP ENTRY (paper) ${Math.round(bid*100)}¢ after −${Math.round(dip*100)}¢ ` +
                  `from ${Math.round(h.px*100)}¢${n > 1 ? ` [trade #${n} on this game]` : ""} | ${(m.question || slug).slice(0, 34)}`);
    }

    if (cycles % 10 === 0) {
      const s = scalpStats();
      console.log(`🧪 SCALP LAB [${s.mode}]: equity $${s.equity} (start $${s.bankrollStart}, ${s.roiPct >= 0 ? "+" : ""}${s.roiPct}%) | ` +
                  `${s.trades} trades | bounce ${s.bounceRate ?? "—"}% | win ${s.winRate ?? "—"}% (need ${s.breakEvenNeeded}%) | ` +
                  `${s.openCount} open | exits W${s.exits.bounce}/L${s.exits.break}/T${s.exits.timeout} | ` +
                  `MFE ${s.avgMaxFavourable ?? "—"}¢ MAE ${s.avgMaxAdverse ?? "—"}¢`);
    }
  } catch (err) {
    console.log(`🧪 scalp lab error (ignored): ${err.message}`);
  } finally {
    running = false;
  }
}

export function startScalpLab() {
  if (!SCALP.ENABLED) {
    console.log("🧪 Scalp lab OFF (set SCALP_PAPER=true to run it in paper mode)");
    return null;
  }
  console.log(`🧪 SCALP LAB ON [${SCALP.MODE.toUpperCase()}] — ${SCALP.LEAGUES.length ? SCALP.LEAGUES.slice(0,3).join("/") : "all sports"}, ` +
              `paper bankroll $${SCALP.BANKROLL}, $${SCALP.STAKE}/trade, ` +
              `dip ≥${Math.round(SCALP.DIP_MIN*100)}¢, take +${Math.round(SCALP.TAKE*100)}¢, ` +
              `stop −${Math.round(SCALP.STOP*100)}¢`);
  return setInterval(() => { runScalpCycle().catch(() => {}); }, SCALP.SCAN_MS);
}