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

  app.get("/api/funnel", (_req, res) => {
    const f = getFunnel();
    res.json({ ...f, ageMs: f.ts ? Date.now() - f.ts : null });
  });

  console.log("⚙️ config API mounted: /api/config, /api/funnel");
}
