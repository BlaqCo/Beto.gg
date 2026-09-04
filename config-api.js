/**
 * config-api.js — dashboard endpoints for live settings + funnel telemetry
 *
 * Add ONE line to index.js (after `const app = express()` and
 * `app.use(express.json())`):
 *
 *     import { mountConfigApi } from "./config-api.js";
 *     mountConfigApi(app);
 *
 * Routes:
 *   GET  /api/config   → { schema, config, status }
 *   POST /api/config   → { config, applied, persisted }   body: { BET_SIZE: 2, ... }
 *   POST /api/config/reset
 *   GET  /api/funnel   → live scan pipeline counts
 */

import { SCHEMA, getConfig, setConfig, resetConfig, configStatus, getFunnel } from "./config.js";
import { interpret, describe } from "./command.js";
import { answer, looksLikeQuestion } from "./brain.js";
import * as actions from "./actions.js";

export function mountConfigApi(app, opts = {}) {
  // getHistory lets BetoBot answer questions about settled bets.
  const getHistory = typeof opts.getHistory === "function" ? opts.getHistory : async () => [];
  app.get("/api/config", async (_req, res) => {
    try {
      const config = await getConfig({ force: true });
      res.json({ schema: SCHEMA, config, status: configStatus() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/config", async (req, res) => {
    try {
      res.json(await setConfig(req.body || {}));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/config/reset", async (_req, res) => {
    try { res.json({ config: await resetConfig() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Plain-English control: "flat bets to $5 and slots to 5"
  app.post("/api/command", async (req, res) => {
    const text = String(req.body?.text || "").slice(0, 400);
    if (!text.trim()) return res.json({ ok: false, message: "Type a change, e.g. \"flat bets to $5, slots to 5\"" });
    try {
      // 1) Money-moving actions — armed first, executed only on confirmation.
      // clear history is destructive — handled here so it needs no confirm token
      if (/\b(clear|wipe|reset|delete)\b.*\b(history|records?|ledger|tracker|stats?)\b/i.test(text)) {
        const t = await import("./tracker.js");
        const alsoLocks = /\block|claims?\b/i.test(text);
        const out = await t.clearHistory({ alsoLocks });
        return res.json({ ok: true, kind: "action",
          message: `Cleared ${out.cleared} stored trade${out.cleared === 1 ? "" : "s"}${alsoLocks ? " and all bet locks" : ""}. The edge tracker starts fresh.` });
      }

      const act = actions.detectAction(text);
      if (act?.type === "confirm") return res.json(await actions.confirmPending());
      if (act?.type === "cancel")  { actions.cancelPending(); return res.json({ ok: true, kind: "action", message: "Cancelled — nothing was done." }); }
      const dryRun = process.env.DRY_RUN !== "false";
      if (act?.type === "sell_all") return res.json(await actions.sellEverything({ alsoPause: act.alsoPause, dryRun }));
      if (act?.type === "all_in")   return res.json(await actions.goAllIn(act.query, { dryRun }));

      // Questions get answered; everything else is treated as a setting change.
      if (looksLikeQuestion(text)) {
        let history = [];
        try { history = await getHistory(); } catch {}
        const a = await answer(text, history);
        console.log(`🗣 asked (${a.source}): "${text}"`);
        return res.json({ ok: true, kind: "answer", message: a.answer });
      }

      const { patch, source } = await interpret(text);
      if (!Object.keys(patch).length) {
        // Not a recognised setting — try answering it instead of failing.
        let history = [];
        try { history = await getHistory(); } catch {}
        const a = await answer(text, history);
        if (a.source !== "none") return res.json({ ok: true, kind: "answer", message: a.answer });
        return res.json({ ok: false, message: "Didn't catch that. Try \"bet size 5\", \"edge 60-70\", \"pause\" — or ask me something like \"which sport is most profitable?\"" });
      }
      const { applied, persisted } = await setConfig(patch);
      if (!Object.keys(applied).length) {
        return res.json({ ok: false, message: "Those values were out of range — nothing changed." });
      }
      console.log(`🗣 command (${source}): "${text}" → ${describe(applied)}`);
      res.json({ ok: true, kind: "change", message: `Updated ${describe(applied)}${persisted ? "" : " (this session only)"}`, applied });
    } catch (e) {
      res.json({ ok: false, message: `Couldn't apply that: ${e.message}` });
    }
  });

  app.get("/api/funnel", (_req, res) => {
    const f = getFunnel();
    res.json({ ...f, ageMs: f.ts ? Date.now() - f.ts : null });
  });

  console.log("⚙️ config API mounted: /api/config, /api/command, /api/funnel");
}
