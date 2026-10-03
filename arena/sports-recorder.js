/**
 * arena/sports-recorder.js — records pre-game prices for sports moneylines so
 * sports strategies can be tested the same way as BTC.
 *
 * READ-ONLY. Uses the sports bot's own market fetcher (fetchSportsMoneylines),
 * which is cached for 60s and shared with the bot, so it adds little traffic.
 * A "window" here runs from when we first see a game to its start time; the
 * outcome is the YES side's settlement after the game.
 *
 * Off unless ARENA_SPORTS=true. Tick: ARENA_SPORTS_TICK_MS (default 5 min).
 */
import * as pm from "../polymarket-us.js";
import { appendWindow } from "./tape.js";
import { saveJSON, loadJSON, pushLine, loadLines } from "./state.js";

// Restart safety: game details go in one small JSON key, prices in an
// append-only list (one line per tick holding every tracked game's price).
const META_KEY = "arena:state:sports", LOG_KEY = "arena:state:sports:ticks", LOG_KEEP = 700;

const TICK_MS = Math.max(60_000, Number(process.env.ARENA_SPORTS_TICK_MS || 300_000));
const SETTLE_POLL_MS = 10 * 60_000;
const SETTLE_GIVE_UP_MS = 36 * 3600_000;
const MAX_TRACKED = 400;

const live = new Map();      // slug -> record (game not started yet)
const pending = new Map();   // slug -> { rec, since, lastTry }
let timer = null;
const stats = { enabled: false, started: 0, lastTickAt: 0, ticks: 0, tracked: 0, windowsSaved: 0, lastError: null };
const num = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };

async function tick() {
  const now = Date.now();
  stats.ticks++; stats.lastTickAt = now;
  let markets = [];
  try { markets = await pm.fetchSportsMoneylines(); } catch (err) { stats.lastError = err.message; }
  const prices = {};
  for (const m of markets || []) {
    const start = m.gameStartIso ? Date.parse(m.gameStartIso) : null;
    if (!start || m.isLive || start <= now || start - now > 48 * 3600_000) continue;
    let rec = live.get(m.slug);
    if (!rec) {
      if (live.size >= MAX_TRACKED) continue;
      rec = { v: 1, family: "sports", slug: m.slug, league: m.league || null, question: (m.question || "").slice(0, 120),
              start: now, end: start, strike: null, outcome: null, ticks: [] };
      live.set(m.slug, rec);
    }
    rec.end = start;                                   // start times can move
    const est = num(m.est);
    if (est != null && est > 0 && est < 1) { rec.ticks.push([now, null, null, +est.toFixed(4), null, "S"]); prices[m.slug] = +est.toFixed(4); }
  }
  if (Object.keys(prices).length) await pushLine(LOG_KEY, { t: now, p: prices }, LOG_KEEP);
  for (const [slug, rec] of live) if (now >= rec.end) { live.delete(slug); pending.set(slug, { rec, since: now, lastTry: 0 }); }
  stats.tracked = live.size;

  for (const [slug, p] of pending) {
    if (now - p.lastTry < SETTLE_POLL_MS) continue;
    p.lastTry = now;
    let outcome = null;
    try { outcome = await pm.getSettlement(slug); } catch {}
    if (outcome != null || now - p.since > SETTLE_GIVE_UP_MS) {
      pending.delete(slug);
      p.rec.outcome = outcome;
      if (p.rec.ticks.length >= 2) {
        await appendWindow(p.rec); stats.windowsSaved++;
        console.log(`  🏟 [arena] saved sports ${slug}: ${p.rec.ticks.length} pre-game ticks, outcome=${outcome == null ? "unknown" : outcome ? "YES" : "NO"}`);
      }
    }
  }
}

const metaOf = r => ({ slug: r.slug, league: r.league, question: r.question, start: r.start, end: r.end });
async function persistMeta() {
  await saveJSON(META_KEY, { savedAt: Date.now(), live: [...live.values()].map(metaOf), pending: [...pending.values()].map(p => ({ ...metaOf(p.rec), since: p.since })) });
}

/** Rebuild tracked games from saved details plus the price log. */
export function rebuildFromSaved(meta, lines, now = Date.now()) {
  const bySlug = new Map();
  const make = g => ({ v: 1, family: "sports", slug: g.slug, league: g.league || null, question: g.question || "", start: g.start, end: g.end, strike: null, outcome: null, ticks: [] });
  for (const g of meta?.live || []) if (g?.slug) bySlug.set(g.slug, { rec: make(g), since: null });
  for (const g of meta?.pending || []) if (g?.slug) bySlug.set(g.slug, { rec: make(g), since: g.since || g.end });
  for (const line of lines || []) for (const [slug, est] of Object.entries(line?.p || {})) {
    const e = bySlug.get(slug); if (!e || line.t < e.rec.start || line.t >= e.rec.end) continue;
    e.rec.ticks.push([line.t, null, null, est, null, "S"]);
  }
  let restoredLive = 0, restoredPending = 0;
  for (const [slug, e] of bySlug) {
    if (live.has(slug) || pending.has(slug)) continue;
    if (e.since == null && now < e.rec.end) { live.set(slug, e.rec); restoredLive++; }
    else { pending.set(slug, { rec: e.rec, since: e.since ?? e.rec.end, lastTry: 0 }); restoredPending++; }
  }
  return { restoredLive, restoredPending };
}

export async function startSportsRecorder() {
  if (process.env.ARENA_SPORTS !== "true") { console.log("🏟 Sports recorder off (set ARENA_SPORTS=true to record pre-game sports prices)"); return; }
  if (timer) return;
  stats.enabled = true; stats.started = Date.now();
  const meta = await loadJSON(META_KEY);
  if (meta) {
    const r = rebuildFromSaved(meta, await loadLines(LOG_KEY));
    stats.restored = r;
    console.log(`🏟 Sports recorder restored ${r.restoredLive} upcoming and ${r.restoredPending} unsettled game(s) from before the restart`);
  }
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await tick(); await persistMeta(); } catch (e) { stats.lastError = e.message; } finally { busy = false; } };
  setTimeout(run, 20_000);
  timer = setInterval(run, TICK_MS);
  console.log(`🏟 Sports recorder on — pre-game moneyline prices every ${Math.round(TICK_MS / 60000)} min (read-only)`);
}

export function sportsRecorderStatus() {
  return { ...stats, tickMs: TICK_MS, awaitingSettlement: pending.size };
}
