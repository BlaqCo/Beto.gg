/**
 * arena/wallet-report.js — a wallet's real track record on global Polymarket, from its closed
 * positions (data-api /closed-positions: one row per finished market with its realized P&L).
 *
 * Grouped by kind (sports / crypto / other), by league (the event slug's prefix, e.g. "mlb"),
 * and by the average price it paid. Used to answer "is the wallet SPORTS SHADOW copies
 * actually good at sports?" and, when SPORTS_LIVE_REQUIRE_RECORD isn't "false", to allow real
 * sports bets only in leagues where its record is proven: RECORD_MIN_N+ finished positions,
 * in profit overall.
 *
 * Read-only. Refreshed every 6 hours; GET /api/walletreport.
 */
const DATA = process.env.COPY_DATA_URL || "https://data-api.polymarket.com";
const PAGE = 500, MAX_PAGES = 8, REFRESH_MS = 6 * 3600_000;
export const RECORD_MIN_N = Number(process.env.SPORTS_RECORD_MIN_N || 20);

const CRYPTO = /(^|-)(btc|bitcoin|eth|ethereum|sol|solana|xrp|doge|crypto)(-|$)/i;
/** "mlb-cle-tb-2026-10-13" → { kind: "sports", league: "mlb" }. */
export function classify(row) {
  const s = String(row.eventSlug || row.slug || "").toLowerCase();
  if (CRYPTO.test(s)) return { kind: "crypto", league: s.startsWith("btc-updown-15m") ? "btc15" : s.split("-").slice(0, 2).join("-") };
  if (/\d{4}-\d{2}-\d{2}/.test(s) && /^[a-z0-9]+-/.test(s)) return { kind: "sports", league: s.split("-")[0] };
  return { kind: "other", league: s.split("-")[0] || "?" };
}
const band = px => (px < 0.35 ? "under 35¢" : px < 0.5 ? "35-50¢" : px < 0.65 ? "50-65¢" : px < 0.8 ? "65-80¢" : "80¢+");
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** A closed-position row as { kind, league, band, cost, pnl }, or null if unusable. */
export function toResult(row) {
  const pnl = num(row.realizedPnl ?? row.realized_pnl ?? row.cashPnl);
  const px = num(row.avgPrice ?? row.avg_price);
  const size = num(row.totalBought ?? row.size ?? row.initialValue);
  if (pnl == null || !(px > 0 && px < 1)) return null;
  const cost = size != null ? (row.totalBought != null ? size * px : size) : null;
  return { ...classify(row), band: band(px), px, cost, pnl, t: num(row.timestamp) || num(Date.parse(row.endDate || "")) || null, title: row.title || "" };
}

export function aggregate(results) {
  const group = keyFn => {
    const m = new Map();
    for (const r of results) {
      const k = keyFn(r), g = m.get(k) || { key: k, n: 0, wins: 0, pnl: 0, cost: 0 };
      g.n++; if (r.pnl > 0) g.wins++; g.pnl += r.pnl; g.cost += r.cost || 0;
      m.set(k, g);
    }
    return [...m.values()].map(g => ({ ...g, pnl: +g.pnl.toFixed(2), cost: +g.cost.toFixed(2), winRate: +(g.wins / g.n).toFixed(3), roi: g.cost > 0 ? +(g.pnl / g.cost).toFixed(3) : null }))
      .sort((a, b) => b.n - a.n);
  };
  return { n: results.length, byKind: group(r => r.kind), byLeague: group(r => `${r.kind}:${r.league}`), sportsByBand: group(r => r.kind === "sports" ? r.band : null).filter(g => g.key) };
}

/** Is the wallet's record in this league good enough for real money? */
export function leagueProven(report, league) {
  const g = report?.byLeague?.find(x => x.key === `sports:${league}`);
  if (!g) return { ok: false, why: `no finished ${league} positions on record for this wallet` };
  if (g.n < RECORD_MIN_N) return { ok: false, why: `only ${g.n} finished ${league} positions on record (need ${RECORD_MIN_N})` };
  if (!(g.pnl > 0)) return { ok: false, why: `its ${league} record loses money (${g.n} positions, ${g.pnl >= 0 ? "+" : ""}$${g.pnl.toFixed(0)})` };
  return { ok: true, why: `${g.n} ${league} positions, ${Math.round(g.winRate * 100)}% won, +$${g.pnl.toFixed(0)}` };
}

// ── Runtime ─────────────────────────────────────────────────────────
let fetchImpl = (...a) => fetch(...a);
const reports = new Map();     // wallet -> { at, report, error, shape }

export async function buildReport(wallet) {
  const rows = [];
  let shape = null;
  for (let p = 0; p < MAX_PAGES; p++) {
    const res = await fetchImpl(`${DATA}/closed-positions?user=${wallet}&limit=${PAGE}&offset=${p * PAGE}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`data-api closed-positions ${res.status}`);
    const page = await res.json();
    const list = Array.isArray(page) ? page : page?.data || page?.positions || [];
    if (!shape && list[0]) shape = Object.keys(list[0]).slice(0, 25);
    rows.push(...list);
    if (list.length < PAGE) break;
  }
  const results = rows.map(toResult).filter(Boolean);
  return { wallet, rows: rows.length, usable: results.length, shape, ...aggregate(results) };
}

export async function refresh(wallet) {
  try {
    const report = await buildReport(wallet);
    reports.set(wallet, { at: Date.now(), report, error: null });
    const s = report.byKind.find(k => k.key === "sports");
    console.log(`  📒 [wallet-report] ${wallet.slice(0, 8)}: ${report.usable} finished positions${s ? `; sports ${s.n}, ${Math.round(s.winRate * 100)}% won, ${s.pnl >= 0 ? "+" : ""}$${s.pnl}` : "; no sports"} (fields: ${(report.shape || []).join(",")})`);
  } catch (err) {
    reports.set(wallet, { ...(reports.get(wallet) || {}), at: Date.now(), error: err.message });
    console.log(`  📒 [wallet-report] ${wallet.slice(0, 8)} failed: ${err.message}`);
  }
  return reports.get(wallet);
}
export const reportFor = wallet => reports.get(String(wallet || "").toLowerCase())?.report || null;
export const walletReportStatus = () => Object.fromEntries([...reports].map(([w, r]) => [w, r]));

export function startWalletReports(wallets) {
  const list = [...new Set((wallets || []).map(w => String(w).toLowerCase()))];
  if (!list.length) return;
  const run = () => list.forEach(w => refresh(w).catch(() => {}));
  setTimeout(run, 15_000);
  setInterval(run, REFRESH_MS);
  console.log(`📒 Wallet reports on for ${list.length} wallet(s), refreshed every ${REFRESH_MS / 3600_000}h`);
}

export function _set({ fetchFn } = {}) { if (fetchFn) fetchImpl = fetchFn; }
export function _put(wallet, report) { reports.set(wallet, { at: Date.now(), report, error: null }); }
