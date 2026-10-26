import { readFileSync } from "node:fs";
import type { Plan } from "../shared/types.js";
import { createApp, PRESETS } from "./app.js";
import { EvidenceCache } from "./cache.js";
import { Gemini } from "./gemini.js";
import { McpTransport, Qloo } from "./qloo.js";

const qloo = new Qloo(new McpTransport());
const llm = new Gemini();
// The recorded Gemini-alone answers for the demo presets (see docs/baseline-seed.json).
const cache = new EvidenceCache(
  process.env.CACHE_DIR ?? ".cache",
  undefined,
  "docs/baseline-seed.json",
);
const deps = { qloo, llm, cache };
// The recorded plans for the two judged presets (see docs/demo-plans.json).
let demoPlans: Plan[] = [];
try {
  demoPlans = JSON.parse(readFileSync("docs/demo-plans.json", "utf8")).plans;
} catch {
  /* no recorded plans: every preset is built live */
}
const { app, warm } = createApp(deps, undefined, demoPlans);
const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const server = app.listen(port, "0.0.0.0", () =>
  console.log(`Front Porch listening on ${port}; model=${llm.name}`),
);

// Build the demo presets in the background (sequentially, to respect the rate limit).
if (process.env.PREWARM !== "0")
  void (async () => {
    for (const p of PRESETS)
      await warm(p.state, p.hazard).then(
        () => console.log(`prewarmed ${p.state}:${p.hazard}`),
        () => console.error(`prewarm failed ${p.state}:${p.hazard}`),
      );
  })();

for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close();
    void qloo.close().finally(() => process.exit(0));
  });
