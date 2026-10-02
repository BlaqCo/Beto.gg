/** Loads every strategy file in this folder (except this one). */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

export async function loadStrategies() {
  const out = [], errors = [];
  for (const f of fs.readdirSync(DIR).sort()) {
    if (!f.endsWith(".js") || f === "index.js") continue;
    try {
      const mod = await import(pathToFileURL(path.join(DIR, f)).href);
      const s = mod.default;
      if (!s?.name || typeof s.decide !== "function" || !["btc15", "btc60", "both"].includes(s.family)) throw new Error("needs name, family (btc15|btc60|both) and decide()");
      out.push(s);
    } catch (err) { errors.push({ file: f, error: err.message }); }
  }
  return { strategies: out, errors };
}
