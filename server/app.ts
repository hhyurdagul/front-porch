import express, { type Request, type Response, type Next } from "express";
import { z } from "zod";
import { resolve } from "node:path";
import {
  HAZARDS,
  type HazardId,
  type Plan,
  type ProgressEvent,
} from "../shared/types.js";
import { STATES } from "./geo.js";
import { buildPlan, type Deps } from "./pipeline.js";
import { AppError, ensure, escapeHtml, redact } from "./security.js";

const PlanInput = z
  .object({
    state: z.string().refine((s) => s in STATES, "Unknown state"),
    hazard: z.string().refine((h) => h in HAZARDS, "Unknown hazard"),
    refresh: z.boolean().optional(),
  })
  .strict();

export const PRESETS: { state: string; hazard: HazardId; label: string }[] = [
  { state: "OK", hazard: "tornado", label: "Oklahoma · tornado" },
  { state: "AL", hazard: "hurricane", label: "Alabama · hurricane" },
  { state: "LA", hazard: "hurricane", label: "Louisiana · hurricane" },
  { state: "AZ", hazard: "heat", label: "Arizona · heat wave" },
  { state: "CA", hazard: "wildfire", label: "California · wildfire" },
  { state: "MS", hazard: "tornado", label: "Mississippi · tornado" },
];

export function createApp(
  deps: Deps,
  limits = {
    plansPerHourPerIp: 12,
    concurrentPlans: 2,
    planTtlMs: 6 * 3600 * 1000,
    timeoutMs: 240000,
  },
  demoPlans: Plan[] = [],
) {
  const app = express();
  app.disable("x-powered-by");
  const plans = new Map<string, Plan>(); // by plan id
  const latest = new Map<string, { id: string; at: number }>(); // by state:hazard
  const inflight = new Map<
    string,
    { listeners: Set<(e: ProgressEvent) => void>; log: ProgressEvent[] }
  >();
  const perIp = new Map<string, number[]>();
  // Recorded demo plans (docs/demo-plans.json) never expire, so the presets load instantly after any restart.
  const pinned = new Map<string, Plan>();
  for (const p of demoPlans) {
    plans.set(p.id, p);
    pinned.set(`${p.state}:${p.hazard}`, p);
  }

  /** Build a plan outside a request (startup warm-up) and store it like a requested one. */
  async function warm(state: string, hazard: HazardId) {
    const key = `${state}:${hazard}`;
    if (inflight.has(key)) return;
    const plan = await buildPlan(deps, state, hazard);
    plans.set(plan.id, plan);
    latest.set(key, { id: plan.id, at: Date.now() });
  }
  app.use((req: Request, res: Response, next: Next) => {
    const json = res.json.bind(res);
    res.json = (v: unknown) => json(redact(v));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: "4kb" }));

  app.get("/api/health", (_req, res) =>
    res.json({
      status: "ok",
      qlooConfigured: Boolean(process.env.QLOO_API_KEY),
      llm: deps.llm.name,
      qlooCalls: deps.qloo.calls,
      cachedPlans: latest.size,
    }),
  );
  app.get("/api/options", (_req, res) =>
    res.json({
      states: Object.entries(STATES),
      hazards: Object.entries(HAZARDS).map(([id, h]) => ({
        id,
        label: h.label,
      })),
      presets: PRESETS.map((p) => ({
        ...p,
        ready:
          latest.has(`${p.state}:${p.hazard}`) ||
          pinned.has(`${p.state}:${p.hazard}`),
      })),
    }),
  );

  // Streams NDJSON progress, then the plan. Identical concurrent requests share one run.
  app.post("/api/plans", async (req: Request, res: Response, next: Next) => {
    try {
      const { state, hazard, refresh } = PlanInput.parse(req.body);
      const key = `${state}:${hazard}`;
      res.type("application/x-ndjson");
      const send = (e: ProgressEvent) => {
        if (!res.destroyed) res.write(JSON.stringify(redact(e)) + "\n");
      };
      const cached = latest.get(key);
      const ready =
        cached &&
        Date.now() - cached.at < limits.planTtlMs &&
        plans.has(cached.id)
          ? plans.get(cached.id)!
          : pinned.get(key);
      if (ready && !refresh) {
        send({
          type: "progress",
          step: "cache",
          detail: `Showing the plan built at ${ready.createdAt.slice(0, 16)}Z (refresh to rebuild live)`,
        });
        send({ type: "result", plan: ready });
        return res.end();
      }
      const run = inflight.get(key);
      if (run) {
        run.log.forEach(send);
        await new Promise<void>((done) => {
          const l = (e: ProgressEvent) => {
            send(e);
            if (e.type !== "progress") {
              run.listeners.delete(l);
              done();
            }
          };
          run.listeners.add(l);
        });
        return res.end();
      }
      const ip =
        String(req.get("x-forwarded-for") ?? "")
          .split(",")[0]
          .trim() || "local";
      const hits = (perIp.get(ip) ?? []).filter(
        (t) => Date.now() - t < 3600000,
      );
      ensure(
        hits.length < limits.plansPerHourPerIp,
        "RATE_LIMIT",
        "Too many new plans from this address. Cached plans stay available.",
        429,
      );
      ensure(
        inflight.size < limits.concurrentPlans,
        "BUSY",
        "Two plans are already being built. Please retry in a minute.",
        503,
      );
      perIp.set(ip, [...hits, Date.now()]);
      const entry = {
        listeners: new Set<(e: ProgressEvent) => void>([send]),
        log: [] as ProgressEvent[],
      };
      inflight.set(key, entry);
      const emit = (e: ProgressEvent) => {
        if (e.type === "progress") entry.log.push(e);
        entry.listeners.forEach((l) => l(e));
      };
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), limits.timeoutMs);
      try {
        const plan = await buildPlan(
          deps,
          state,
          hazard as HazardId,
          (step, detail) => emit({ type: "progress", step, detail }),
          ac.signal,
        );
        plans.set(plan.id, plan);
        latest.set(key, { id: plan.id, at: Date.now() });
        emit({ type: "result", plan });
      } catch (e) {
        emit({
          type: "error",
          code: e instanceof AppError ? e.code : "PLAN_FAILED",
          message:
            e instanceof AppError
              ? e.message
              : ac.signal.aborted
                ? "The plan took too long and was stopped."
                : "The plan could not be built; no substitute evidence was generated.",
        });
      } finally {
        clearTimeout(timer);
        inflight.delete(key);
      }
      res.end();
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/plans/:id", (req: Request, res: Response, next: Next) => {
    const plan = plans.get(req.params.id);
    if (!plan)
      return next(new AppError("NOT_FOUND", "Plan not found or expired.", 404));
    if (req.query.format === "html") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="front-porch-${plan.state}-${plan.hazard}.html"`,
      );
      return res.type("html").send(briefHtml(plan));
    }
    if (req.query.format === "json")
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="front-porch-${plan.state}-${plan.hazard}.json"`,
      );
    res.json(plan);
  });

  app.use("/api", (_req: Request, res: Response) =>
    res.status(404).json({ code: "NOT_FOUND", error: "Unknown API route" }),
  );
  app.use(express.static(resolve("dist/ui")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve("dist/ui/index.html")),
  );
  app.use((err: unknown, _req: Request, res: Response, _next: Next) => {
    if (res.headersSent) return res.end();
    const invalid = err instanceof z.ZodError;
    res.status(err instanceof AppError ? err.http : invalid ? 400 : 500).json({
      code:
        err instanceof AppError
          ? err.code
          : invalid
            ? "VALIDATION"
            : "REQUEST_FAILED",
      error:
        err instanceof AppError
          ? err.message
          : invalid
            ? "Invalid request."
            : "Request failed.",
    });
  });
  return { app, warm };
}

/** A self-contained, printable outreach brief: partners, evidence, the Gemini comparison and drafts. */
export function briefHtml(p: Plan) {
  const e = escapeHtml;
  const rec = p.partners.filter((x) => x.status === "recommended");
  const figure = (x: Plan["partners"][number]) =>
    x.kind === "artist" || x.kind === "person";
  const rows = (xs: string[][]) =>
    xs
      .map((r) => `<tr>${r.map((c) => `<td>${e(c)}</td>`).join("")}</tr>`)
      .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Front Porch: ${e(p.stateName)} ${e(HAZARDS[p.hazard].label)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1d2433}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #d5dbe5;padding:.4rem .6rem;text-align:left;vertical-align:top}th{background:#f2f5f9}pre{white-space:pre-wrap;background:#f7f8fa;padding:1rem;border-radius:8px}small{color:#5b6475}</style>
<h1>Front Porch outreach brief</h1>
<p><b>${e(p.stateName)} · ${e(HAZARDS[p.hazard].label)}</b> · built ${e(p.createdAt.slice(0, 16))}Z · model ${e(p.model)}</p>
<p>${e(p.summary)}</p>
<h2>Highest-risk counties (FEMA National Risk Index)</h2>
<table><tr><th>County</th><th>Risk score</th><th>Rating</th><th>Population</th></tr>${rows(p.counties.filter((c) => c.top).map((c) => [`${c.name} ${c.kind}`, c.risk.toFixed(1), c.rating, c.population.toLocaleString("en-US")]))}</table>
<h2>Recommended partners (human review required)</h2>
<table><tr><th>Partner</th><th>Type</th><th>Evidence</th></tr>${rows(rec.filter((x) => !figure(x)).map((x) => [x.name, x.kind, x.why]))}</table>
${rec.some(figure) ? `<h2>Public figures: vet before inviting</h2><p><small>Qloo shows where a following lives, not whether a public figure suits an official safety message. No invitation is drafted for these.</small></p><table><tr><th>Name</th><th>Type</th><th>Evidence</th></tr>${rows(rec.filter(figure).map((x) => [x.name, x.kind, x.why]))}</table>` : ""}
<h2>Gemini alone, checked the same way</h2>
${p.baseline.length ? `<table><tr><th>Suggestion</th><th>Verdict</th><th>Evidence</th></tr>${rows(p.baseline.map((b) => [b.name, b.verdict, b.note]))}</table>` : `<p>${e(p.model)} gave no list for this plan${p.baselineError ? ` (${e(p.baselineError)})` : ""}.</p>`}
<h2>Invitation drafts</h2>${p.invitations.map((i) => `<h3>${e(i.subject)}</h3><pre>${e(i.body)}</pre>`).join("")}
<h2>Method and limits</h2><p><small>Qloo affinity shows where a following is concentrated relative to elsewhere; it is not an audience count, a measure of trust, or evidence that a message changes behaviour. Every invitation needs human approval. The official safety text is adapted from National Weather Service guidance and inserted unchanged. Sources: FEMA National Risk Index (county layer, December 2025 release), Qloo hackathon API via the official harness, Wikidata. ${p.trace.length} upstream requests are listed in the JSON export.</small></p></html>`;
}
