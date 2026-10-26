// Live end-to-end run from the command line: node --env-file=.env --import tsx scripts/run-plan.ts OK tornado
import { writeFile } from "node:fs/promises";
import { Gemini } from "../server/gemini.js";
import { buildPlan } from "../server/pipeline.js";
import { McpTransport, Qloo } from "../server/qloo.js";
import type { HazardId } from "../shared/types.js";
const [state = "OK", hazard = "tornado"] = process.argv.slice(2);
import { EvidenceCache } from "../server/cache.js";
const qloo = new Qloo(new McpTransport());
const cache = new EvidenceCache(".cache");
const t0 = Date.now();
const plan = await buildPlan(
  { qloo, llm: new Gemini(), cache },
  state,
  hazard as HazardId,
  (s, d) =>
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}: ${d ?? ""}`),
);
await writeFile(
  `evaluation/plan-${state}-${hazard}.json`,
  JSON.stringify(plan, null, 1),
);
console.log(
  "\nSUMMARY:",
  plan.summary,
  `\nQloo calls: ${qloo.calls}; ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
for (const p of plan.partners.slice(0, 14))
  console.log(
    `${p.status.padEnd(11)} ${p.kind.padEnd(10)} ${p.name} | home ${Math.round(p.homeShare * 100)}% ${JSON.stringify(p.homeStates)} | fp ${p.footprint.toFixed(2)} risk ${p.riskWeighted.toFixed(0)} | ${p.wikidata.place ?? ""}${p.wikidata.inState ? " ✓" : ""}`,
  );
console.log("\nGEMINI ALONE:");
for (const b of plan.baseline)
  console.log(`${b.verdict.padEnd(9)} ${b.name} | ${b.note}`);
console.log("\nSCORECARD", JSON.stringify(plan.scorecard));
console.log("WARNINGS", plan.warnings);
console.log(
  "\nINVITE 1:\n" +
    (plan.invitations[0]?.subject ?? "") +
    "\n" +
    (plan.invitations[0]?.body ?? ""),
);
await qloo.close();
process.exit(0);
