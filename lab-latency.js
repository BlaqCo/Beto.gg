/**
 * lab-latency.js — LATENCY LAB (measurement only, fully isolated)
 *
 * Answers one question: after something happens in a CS2/Valorant/LoL match,
 * how long does Polymarket take to reprice it?
 *
 * That number decides whether the "faster than the price update" strategy is
 * reachable at all:
 *   • gap of 5-30s  → a real window exists; a fast bot could work
 *   • gap under 2s  → the market is already fast; don't compete
 *
 * ISOLATION — this module:
 *   • never imports or calls any order function; it cannot trade
 *   • never touches state.js, config.js, or the live bot's data
 *   • runs on its own timer, only when LATENCY_LAB=true
 *   • wraps every operation in try/catch — a failure here cannot affect
 *     the sports bot or the scalp lab
 *
 * It works WITHOUT any third-party sports feed by using Polymarket's own
 * event data as the trigger: the v2 events endpoint carries live `score`
 * and `period`. When the score changes, that IS the round-end event. We then
 * watch how long the price takes to move, and by how much.
 */

import * as pm from "./polymarket-us.js";

export const LAT = {
  ENABLED:   process.env.LATENCY_LAB === "true",
  SCAN_MS:   3_000,       // poll fast — we're measuring reaction time
  LEAGUES:   ["CS2", "CSGO", "COUNTER-STRIKE", "VALORANT", "LOL", "LCK", "LEC", "LPL", "LCS"],
  MOVE_MIN:  0.02,        // a "reprice" means the price moved at least 2¢
  WATCH_MS:  90_000,      // how long to watch after an event before giving up
  TRACK_MAX: 12,
};

const tracked = new Map();  // slug → { score, period, px, ts }
const pending = new Map();  // slug → { at, pxAtEvent, score, note }
const samples = [];         // completed measurements
let cycles = 0, running = false, lastRun = 0;

export function latencyStats() {
  const reacted = samples.filter(s => s.gapMs != null);
  const gaps = reacted.map(s => s.gapMs / 1000).sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const moves = reacted.map(s => Math.abs(s.move) * 100);
  return {
    enabled: LAT.ENABLED, cycles, tracking: tracked.size, pending: pending.size,
    events: samples.length,
    repriced: reacted.length,
    noMove: samples.length - reacted.length,
    medianGapSec: med == null ? null : +med.toFixed(1),
    fastestSec: gaps.length ? +gaps[0].toFixed(1) : null,
    slowestSec: gaps.length ? +gaps[gaps.length - 1].toFixed(1) : null,
    avgMoveCents: moves.length ? +(moves.reduce((a, b) => a + b, 0) / moves.length).toFixed(1) : null,
    verdict: (() => {
      if (reacted.length < 8) return `Need ~8 events to judge (have ${reacted.length}).`;
      if (med >= 5)  return `Median ${med.toFixed(1)}s gap — a real window exists. A faster bot could trade this.`;
      if (med >= 2)  return `Median ${med.toFixed(1)}s — narrow. Only worthwhile with a WebSocket feed.`;
      return `Median ${med.toFixed(1)}s — the market reprices almost instantly. Not worth competing.`;
    })(),
    recent: samples.slice(-12).reverse(),
  };
}

const inLeague = m => {
  const hay = `${m.league || ""} ${m.slug || ""} ${m.question || ""}`.toUpperCase();
  return LAT.LEAGUES.some(t => hay.includes(t));
};

export async function runLatencyCycle() {
  if (!LAT.ENABLED || running) return;
  running = true;
  try {
    if (Date.now() - lastRun < LAT.SCAN_MS) return;
    lastRun = Date.now(); cycles++;

    const markets = await pm.fetchSportsMoneylines();
    const live = markets.filter(m => m.isLive && inLeague(m)).slice(0, LAT.TRACK_MAX);
    if (!live.length) return;

    const now = Date.now();

    for (const m of live) {
      const slug = m.slug;
      const q = await pm.getBBO(slug).catch(() => null);
      if (!q?.bid || !q?.ask) continue;
      const px = (q.bid + q.ask) / 2;
      const score = m.evScore ?? null;
      const period = m.evPeriod ?? null;

      const prev = tracked.get(slug);
      tracked.set(slug, { score, period, px, ts: now });
      if (!prev) continue;

      // 1) Is an earlier event still waiting for the price to move?
      const wait = pending.get(slug);
      if (wait) {
        const move = px - wait.pxAtEvent;
        if (Math.abs(move) >= LAT.MOVE_MIN) {
          const gapMs = now - wait.at;
          samples.push({ slug, q: (m.question || slug).slice(0, 40), note: wait.note,
                         gapMs, move: +move.toFixed(3), at: new Date(wait.at).toISOString() });
          pending.delete(slug);
          console.log(`⏱ LATENCY: repriced ${(gapMs / 1000).toFixed(1)}s after "${wait.note}" ` +
                      `(${move >= 0 ? "+" : ""}${Math.round(move * 100)}¢) | ${(m.question || slug).slice(0, 30)}`);
        } else if (now - wait.at > LAT.WATCH_MS) {
          samples.push({ slug, q: (m.question || slug).slice(0, 40), note: wait.note,
                         gapMs: null, move: +move.toFixed(3), at: new Date(wait.at).toISOString() });
          pending.delete(slug);
          console.log(`⏱ LATENCY: no reprice within ${LAT.WATCH_MS / 1000}s after "${wait.note}" | ${(m.question || slug).slice(0, 30)}`);
        }
      }

      // 2) Did a new event just happen? (score or period changed)
      const scoreChanged  = score != null && prev.score != null && score !== prev.score;
      const periodChanged = period != null && prev.period != null && period !== prev.period;
      if ((scoreChanged || periodChanged) && !pending.has(slug)) {
        const note = scoreChanged ? `score ${prev.score}→${score}` : `period ${prev.period}→${period}`;
        pending.set(slug, { at: now, pxAtEvent: prev.px, score, note });
        console.log(`⏱ EVENT: ${note} @ ${Math.round(prev.px * 100)}¢ | ${(m.question || slug).slice(0, 34)}`);
      }

      await new Promise(r => setTimeout(r, 40));
    }

    if (cycles % 20 === 0) {
      const s = latencyStats();
      console.log(`⏱ LATENCY LAB: ${s.events} events | ${s.repriced} repriced | ` +
                  `median ${s.medianGapSec ?? "—"}s | avg move ${s.avgMoveCents ?? "—"}¢ | ${s.verdict}`);
    }
  } catch (err) {
    console.log(`⏱ latency lab error (ignored): ${err.message}`);
  } finally {
    running = false;
  }
}

export function startLatencyLab() {
  if (!LAT.ENABLED) {
    console.log("⏱ Latency lab OFF (set LATENCY_LAB=true to measure reprice speed)");
    return null;
  }
  console.log(`⏱ LATENCY LAB ON — measuring only, no trading. Watching ${LAT.LEAGUES.slice(0, 3).join("/")}`);
  return setInterval(() => { runLatencyCycle().catch(() => {}); }, LAT.SCAN_MS);
}
