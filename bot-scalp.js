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
  TRACK_MAX:   25,       // markets quoted per cycle (API-friendly)

  // Only these leagues. Round-based esports overshoot most reliably.
  // Empty array = every live market.
  LEAGUES:     ["CS2", "VALORANT", "CSGO", "COUNTER-STRIKE"],

  PX_MIN:      0.45,     // scalp zone is wider than the value bot's band
  PX_MAX:      0.75,
  DIP_MIN:     0.09,     // deeper overshoot = more room to revert (was 6¢)
  DIP_WINDOW:  6 * 60_000, // the drop must be recent

  BANKROLL:    500,      // paper starting balance
  STAKE:       10,       // paper dollars per scalp
  // Risk/reward must respect the observed bounce rate: break-even is
  // stop/(stop+take), so a 4¢/5¢ pair needs ~56% — under the 61% seen so far.
  // The old 3¢/8¢ pair needed 73% and could never work.
  TAKE:        0.04,     // exit +4¢
  STOP:        0.05,     // exit −5¢
  MAX_SPREAD:  0.03,     // wide books gap through stops — skip them
  MAX_HOLD_MS: 20 * 60_000,
  MAX_OPEN:    6,

  FEE_COEF:    0.03,     // entry assumed maker (free); exit pays taker
};

const feeFor = (px, usd) => SCALP.FEE_COEF * (usd / Math.max(px, 0.01)) * Math.min(px, 1 - px);

// ── isolated state ───────────────────────────────────────────────
const high   = new Map();  // slug → { px, ts }
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
    breakEvenNeeded: (() => {
      const px = (SCALP.PX_MIN + SCALP.PX_MAX) / 2;
      const win = SCALP.STAKE * (SCALP.TAKE / px) - feeFor(px, SCALP.STAKE);
      const loss = SCALP.STAKE * (SCALP.STOP / px) + feeFor(px, SCALP.STAKE);
      return +(loss / (win + loss) * 100).toFixed(1);
    })(),
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
      p.maxBounce = Math.max(p.maxBounce ?? 0, bid - p.entry);
      p.minPx = Math.min(p.minPx ?? bid, bid);

      let reason = null;
      if (bid >= p.entry + SCALP.TAKE)          reason = "bounce";
      else if (bid <= p.entry - SCALP.STOP)     reason = "break";
      else if (now - p.ts >= SCALP.MAX_HOLD_MS) reason = "timeout";
      if (!reason) continue;

      const shares = p.stake / p.entry;
      const gross  = shares * bid - p.stake;
      const fee    = feeFor(bid, shares * bid);            // exit is a taker sale
      const pnl    = +(gross - fee).toFixed(3);
      closed.push({ slug, q: p.q, league: p.league, entry: p.entry, exit: bid, reason, pnl,
                    heldMin: +((now - p.ts) / 60000).toFixed(1), maxBounce: p.maxBounce });
      open.delete(slug);
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

      const h = high.get(slug);
      if (!h || ask > h.px) { high.set(slug, { px: ask, ts: now }); continue; }

      const dip = h.px - ask;
      const fresh = now - h.ts <= SCALP.DIP_WINDOW;
      if (!fresh || dip < SCALP.DIP_MIN) continue;
      if (ask < SCALP.PX_MIN || ask > SCALP.PX_MAX) continue;

      // PAPER ENTRY — assumes a maker fill at the bid, so no entry fee.
      const lg = (SCALP.LEAGUES.find(t => `${m.slug} ${m.question}`.toUpperCase().includes(t)) || "OTHER");
      open.set(slug, { q: m.question || slug, league: lg, entry: bid, stake: SCALP.STAKE,
                       ts: now, maxBounce: 0, minPx: bid, high: h.px });
      console.log(`🧪 SCALP ENTRY (paper) ${Math.round(bid*100)}¢ after −${Math.round(dip*100)}¢ ` +
                  `from ${Math.round(h.px*100)}¢ | ${(m.question || slug).slice(0, 34)}`);
    }

    if (cycles % 10 === 0) {
      const s = scalpStats();
      console.log(`🧪 SCALP LAB: equity $${s.equity} (start $${s.bankrollStart}, ${s.roiPct >= 0 ? "+" : ""}${s.roiPct}%) | ` +
                  `${s.trades} trades | bounce ${s.bounceRate ?? "—"}% | win ${s.winRate ?? "—"}% (need ${s.breakEvenNeeded}%) | ` +
                  `${s.openCount} open | exits B${s.exits.bounce}/S${s.exits.break}/T${s.exits.timeout}`);
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
  console.log(`🧪 SCALP LAB ON — ${SCALP.LEAGUES.length ? SCALP.LEAGUES.slice(0,2).join("/") : "all sports"}, ` +
              `paper bankroll $${SCALP.BANKROLL}, $${SCALP.STAKE}/trade, ` +
              `dip ≥${Math.round(SCALP.DIP_MIN*100)}¢, take +${Math.round(SCALP.TAKE*100)}¢, ` +
              `stop −${Math.round(SCALP.STOP*100)}¢`);
  return setInterval(() => { runScalpCycle().catch(() => {}); }, SCALP.SCAN_MS);
}
