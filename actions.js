/**
 * actions.js — BetoBot's hands
 *
 * Commands that move real money: closing everything out, or putting the
 * cash balance on one game. These never fire on the first request — each
 * returns a preview and a token, and only runs when the operator confirms.
 * The bot's own size tripwire is bypassed here because these are explicit
 * human instructions, not automated entries; every one is logged in full.
 */

import * as pm from "./polymarket-us.js";
import { setConfig } from "./config.js";

const PENDING_TTL = 90_000;
let pending = null;   // { kind, run, preview, ts }

export function hasPending() {
  if (pending && Date.now() - pending.ts > PENDING_TTL) pending = null;
  return !!pending;
}
export function pendingPreview() { return pending?.preview || null; }
export function cancelPending() { pending = null; }

function arm(kind, preview, run) {
  pending = { kind, preview, run, ts: Date.now() };
  return { ok: true, kind: "confirm", message: `${preview}\n\nReply "yes" to confirm, or "cancel".` };
}

export async function confirmPending() {
  if (!hasPending()) return { ok: false, message: "Nothing waiting for confirmation." };
  const p = pending; pending = null;
  try {
    return await p.run();
  } catch (e) {
    return { ok: false, message: `That failed: ${e.message}` };
  }
}

// ── sell everything / stop ───────────────────────────────────────
export async function sellEverything({ alsoPause = true, dryRun = false } = {}) {
  const positions = await pm.getOpenPositions();
  const slugs = Object.entries(positions || {})
    .filter(([, v]) => v.qtyBought > 0)
    .map(([slug, v]) => ({ slug, value: v.cashValue ?? v.cost ?? 0 }));

  if (!slugs.length) {
    if (alsoPause) await setConfig({ PAUSED: true });
    return { ok: true, kind: "action", message: `No open positions to sell.${alsoPause ? " Bot is paused — no new bets." : ""}` };
  }

  const total = slugs.reduce((a, x) => a + Number(x.value || 0), 0);
  return arm("sell_all",
    `Sell all ${slugs.length} open position${slugs.length === 1 ? "" : "s"} (about $${total.toFixed(2)} of value) at the current bid${alsoPause ? " and pause the bot" : ""}. Selling into the bid means paying the spread on each.`,
    async () => {
      if (dryRun) {
        if (alsoPause) await setConfig({ PAUSED: true });
        return { ok: true, kind: "action", message: `Paper mode: would have sold ${slugs.length} positions.${alsoPause ? " Bot paused." : ""}` };
      }
      let sold = 0, failed = 0;
      for (const { slug } of slugs) {
        const r = await pm.closePositionLive(slug);
        if (r?.ok) { sold++; console.log(`💸 SOLD ${slug}`); }
        else { failed++; console.log(`⚠️ Sell failed ${slug}: ${r?.error}`); }
      }
      if (alsoPause) await setConfig({ PAUSED: true });
      return { ok: true, kind: "action",
        message: `Sold ${sold} position${sold === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.${alsoPause ? " Bot is paused — no new bets until you resume." : ""}` };
    });
}

// ── go all in on one game ────────────────────────────────────────
const norm = t => String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export async function goAllIn(query, { dryRun = false } = {}) {
  const q = norm(query);
  if (q.length < 3) return { ok: false, message: "Tell me which game — e.g. \"go all in on Fritz\"." };

  const markets = await pm.fetchSportsMoneylines();
  const terms = q.split(" ").filter(w => w.length > 2);
  const scored = markets.map(m => {
    const hay = norm(`${m.question} ${m.slug}`);
    const hits = terms.filter(t => hay.includes(t)).length;
    return { m, hits };
  }).filter(x => x.hits > 0).sort((a, b) => b.hits - a.hits);

  if (!scored.length) return { ok: false, message: `No live market matches "${query}". Try a player or team name exactly as it appears on Polymarket.` };
  if (scored.length > 1 && scored[0].hits === scored[1].hits) {
    const opts = scored.slice(0, 4).map(x => `• ${x.m.question}`).join("\n");
    return { ok: false, message: `That matches more than one market:\n${opts}\n\nBe more specific.` };
  }

  const m = scored[0].m;
  const bal = await pm.getBuyingPower();
  const cash = Number(bal?.buyingPower ?? bal?.currentBalance ?? 0);
  if (!(cash > 1)) return { ok: false, message: `Buying power is $${cash.toFixed(2)} — not enough to place a bet.` };
  if (!m.ask) return { ok: false, message: `No live price on that market right now.` };

  const stake = Math.floor(cash * 100) / 100;
  const contracts = stake / m.ask;
  const toWin = contracts - stake;

  return arm("all_in",
    `ALL IN: $${stake.toFixed(2)} on "${m.question}" at ${Math.round(m.ask * 100)}¢.\nWins → +$${toWin.toFixed(2)}. Loses → −$${stake.toFixed(2)}, your entire balance.\nThis ignores the band, slot cap and size limits.`,
    async () => {
      if (dryRun) return { ok: true, kind: "action", message: `Paper mode: would have put $${stake.toFixed(2)} on ${m.question} at ${Math.round(m.ask * 100)}¢.` };
      console.log(`🎰 ALL-IN ORDER: $${stake.toFixed(2)} @ ${m.ask} | ${m.slug}`);
      const r = await pm.buyYesFOK({ slug: m.slug, sizeUsd: stake, ask: m.ask,
                                     tick: m.tick, minQty: m.minQty,
                                     allowAddOn: true, override: true });
      if (!r?.filled) return { ok: false, message: `Order didn't fill: ${r?.error || "unknown"}` };
      return { ok: true, kind: "action",
        message: `Filled $${(r.cost ?? stake).toFixed(2)} on ${m.question} at ${Math.round((r.fillPrice ?? m.ask) * 100)}¢.` };
    });
}

// ── intent detection ─────────────────────────────────────────────
export function detectAction(text) {
  const t = String(text || "");
  if (/^\s*(yes|yep|confirm|do it|go ahead|y)\s*$/i.test(t)) return { type: "confirm" };
  if (/^\s*(no|cancel|stop|nevermind|never mind|n)\s*$/i.test(t) && hasPending()) return { type: "cancel" };
  if (/\b(sell|close|dump|liquidate|cash out)\b.*\b(everything|all|positions?)\b/i.test(t) ||
      /\b(everything|all positions?)\b.*\b(sell|close|out)\b/i.test(t)) {
    return { type: "sell_all", alsoPause: /\b(turn off|shut|stop|pause|kill|off)\b/i.test(t) };
  }
  const allIn = t.match(/\b(?:go\s+)?all[- ]?in\s+(?:on\s+)?(.+)$/i) ||
                t.match(/\b(?:bet|put)\s+(?:it\s+)?all\s+(?:on\s+)?(.+)$/i);
  if (allIn) return { type: "all_in", query: allIn[1].trim() };
  return null;
}
