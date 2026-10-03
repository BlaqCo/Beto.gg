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
    if (est != null && est > 0 && est < 1) rec.ticks.push([now, null, null, +est.toFixed(4), null, "S"]);
  }
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

export function startSportsRecorder() {
  if (process.env.ARENA_SPORTS !== "true") { console.log("🏟 Sports recorder off (set ARENA_SPORTS=true to record pre-game sports prices)"); return; }
  if (timer) return;
  stats.enabled = true; stats.started = Date.now();
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { await tick(); } catch (e) { stats.lastError = e.message; } finally { busy = false; } };
  setTimeout(run, 20_000);
  timer = setInterval(run, TICK_MS);
  console.log(`🏟 Sports recorder on — pre-game moneyline prices every ${Math.round(TICK_MS / 60000)} min (read-only)`);
}

export function sportsRecorderStatus() {
  return { ...stats, tickMs: TICK_MS, awaitingSettlement: pending.size };
}
