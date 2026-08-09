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

export function mountConfigApi(app) {
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
      const { patch, source } = await interpret(text);
      if (!Object.keys(patch).length) {
        return res.json({ ok: false, message: "Didn't recognise a setting in that. Try \"bet size 5\", \"edge 60-70\", or \"pause\"." });
      }
      const { applied, persisted } = await setConfig(patch);
      if (!Object.keys(applied).length) {
        return res.json({ ok: false, message: "Those values were out of range — nothing changed." });
      }
      console.log(`🗣 command (${source}): "${text}" → ${describe(applied)}`);
      res.json({ ok: true, message: `Updated ${describe(applied)}${persisted ? "" : " (this session only)"}`, applied });
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
