import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { AppError, ensure } from "./security.js";

// Exact tools/list snapshot from the pinned 0.1.26 harness (scripts/discover.ts).
const discovered = JSON.parse(
  readFileSync("docs/qloo-tools.discovered.json", "utf8"),
) as { name: string; inputSchema: object; outputSchema: object }[];
const ajv = new Ajv({ strict: false });
const validators = new Map(
  discovered.map((t) => [
    t.name,
    { input: ajv.compile(t.inputSchema), output: ajv.compile(t.outputSchema) },
  ]),
);
const ALLOWED = new Set([
  "qloo_capabilities",
  "qloo_describe",
  "qloo_recommend",
  "qloo_where_popular",
]);

export interface Envelope {
  status: "ok" | "empty" | "needs_input" | "partial" | "degraded" | "error";
  results?: unknown[];
  resolution?: { issues?: { candidates?: Candidate[] }[] };
  error?: { code?: string; retryable?: boolean };
  [k: string]: unknown;
}
export interface Candidate {
  id: string;
  name: string;
  type?: string;
  popularity?: number;
}
export interface EntityRow {
  id: string;
  name: string;
  type: string;
  popularity: number;
}
export interface CellRow {
  geohash: string;
  affinityRank: number;
  popularity: number;
}

/** Raw tool access. Implemented over MCP in production and by fixtures in tests. */
export interface QlooTransport {
  call(tool: string, args: Record<string, unknown>): Promise<Envelope>;
  close(): Promise<void>;
}

export function validate(tool: string, dir: "input" | "output", v: unknown) {
  ensure(
    validators.get(tool)?.[dir](v),
    "TOOL_SCHEMA",
    `Qloo ${tool} ${dir} does not match the discovered MCP schema.`,
    502,
  );
}

export class McpTransport implements QlooTransport {
  private client?: Client;
  private transport?: Transport;
  private connecting?: Promise<void>;
  constructor(
    private timeout = 15000,
    private makeTransport?: () => Transport,
  ) {}
  private async init() {
    const base = "https://hackathon.api.qloo.com";
    ensure(
      process.env.QLOO_BASE_URL === base &&
        process.env.QLOO_TRUSTED_BASE_URL === base,
      "BASE_URL",
      "Both Qloo base URLs must use the hackathon endpoint.",
      503,
    );
    ensure(
      process.env.QLOO_API_KEY,
      "QLOO_NOT_READY",
      "QLOO_API_KEY is missing.",
      503,
    );
    const env = Object.fromEntries(
      [
        "PATH",
        "QLOO_API_KEY",
        "QLOO_BASE_URL",
        "QLOO_TRUSTED_BASE_URL",
        "QLOO_HOME",
      ].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
    );
    env.QLOO_HOME ??= resolve(".qloo");
    ensure(
      resolve(env.QLOO_HOME) !== homedir(),
      "QLOO_HOME",
      "QLOO_HOME must be a dedicated subdirectory, not the user home.",
      503,
    );
    this.transport =
      this.makeTransport?.() ??
      new StdioClientTransport({
        command: resolve("tooling/node_modules/.bin/qloo"),
        args: ["mcp"],
        env,
        stderr: "pipe", // never logged: upstream messages may contain credentials
      });
    this.client = new Client({ name: "frontporch", version: "0.1.0" });
    await this.client.connect(this.transport, { timeout: this.timeout });
    const r = await this.client.callTool(
      { name: "qloo_capabilities", arguments: {} },
      undefined,
      { timeout: this.timeout },
    );
    ensure(
      (r.structuredContent as { adapter?: { ready?: boolean } })?.adapter
        ?.ready,
      "QLOO_NOT_READY",
      "Harness readiness did not report Qloo ready.",
      503,
    );
  }
  connect() {
    this.connecting ??= this.init().catch(async (e) => {
      await this.close();
      throw e;
    });
    return this.connecting;
  }
  async call(tool: string, args: Record<string, unknown>) {
    ensure(
      ALLOWED.has(tool),
      "TOOL_NOT_ALLOWED",
      `Tool ${tool} is not allowed.`,
      502,
    );
    await this.connect();
    const r = await this.client!.callTool(
      { name: tool, arguments: args },
      undefined,
      {
        timeout: this.timeout,
      },
    );
    // The harness returns error envelopes (e.g. QLOO_RATE_LIMIT) as structured content flagged isError.
    const sc = r.structuredContent as Envelope | undefined;
    ensure(
      sc && (!r.isError || sc.status === "error"),
      "MCP_RESULT",
      "MCP did not return structured content.",
      502,
    );
    return sc;
  }
  async close() {
    await this.client?.close().catch(() => {});
    await this.transport?.close().catch(() => {});
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
  }
}

/** Typed Qloo operations with schema validation, pacing and bounded retries. */
export class Qloo {
  calls = 0;
  private active = 0;
  private queue: (() => void)[] = [];
  private lastStart = 0;
  constructor(
    private t: QlooTransport,
    private concurrency = 3,
    private gapMs = 250,
    private backoff = [1500, 4000],
  ) {}
  /** At most `concurrency` calls in flight, starts spaced by `gapMs`, so one plan never bursts the key's rate limit. */
  private async paced<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency)
      await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      const wait = this.lastStart + this.gapMs - Date.now();
      this.lastStart = Math.max(Date.now(), this.lastStart + this.gapMs);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
  async call(tool: string, args: Record<string, unknown>): Promise<Envelope> {
    validate(tool, "input", args);
    for (let attempt = 0; ; attempt++) {
      const e = await this.paced(() => this.t.call(tool, args));
      this.calls++;
      validate(tool, "output", e);
      if (
        e.status !== "error" ||
        !e.error?.retryable ||
        attempt >= this.backoff.length
      ) {
        if (e.status === "error" && e.error?.code === "QLOO_RATE_LIMIT")
          throw new AppError(
            "QLOO_RATE_LIMIT",
            "Qloo rate limit reached. Wait a minute, then retry.",
            503,
          );
        if (e.status === "error")
          throw new AppError(
            e.error?.code ?? "QLOO_ERROR",
            "Qloo returned an error.",
            502,
          );
        return e;
      }
      await new Promise((r) => setTimeout(r, this.backoff[attempt]));
    }
  }
  /** Entities with concentrated affinity around a place (a county or city name). */
  async recommendNear(
    targetType: "brand" | "artist" | "podcast",
    location: string,
    limit = 15,
  ) {
    const e = await this.call("qloo_recommend", {
      target_type: targetType,
      signal_location: location,
      limit,
    });
    return { envelope: e, rows: entityRows(e) };
  }
  /** Real venues inside a place that fit that place's taste profile. */
  async placesIn(location: string, limit = 15) {
    const e = await this.call("qloo_recommend", {
      target_type: "place",
      signal_location: location,
      filter_location: location,
      limit,
    });
    return { envelope: e, rows: placeRows(e) };
  }
  /** Top affinity cells for one entity (Qloo id or name) within an area. */
  async wherePopular(entity: string, within: string, limit = 20) {
    const e = await this.call("qloo_where_popular", { entity, within, limit });
    return { envelope: e, cells: cellRows(e) };
  }
  /** Resolve a free-text name to Qloo entities (exact match or ambiguity candidates). */
  async describe(entity: string) {
    const e = await this.call("qloo_describe", { entity });
    return { envelope: e, candidates: describeCandidates(e) };
  }
  close() {
    return this.t.close();
  }
}

const num = (v: unknown, d = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : d;

export function entityRows(e: Envelope): EntityRow[] {
  if (e.status !== "ok" && e.status !== "partial" && e.status !== "degraded")
    return [];
  const seen = new Set<string>();
  const out: EntityRow[] = [];
  for (const r of (e.results ?? []) as Record<string, unknown>[]) {
    const id = typeof r.entity_id === "string" ? r.entity_id : undefined;
    const name = typeof r.name === "string" ? r.name : undefined;
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      type:
        typeof r.subtype === "string"
          ? r.subtype
          : typeof r.type === "string"
            ? r.type
            : "unknown",
      popularity: num(r.popularity),
    });
  }
  return out;
}

export interface PlaceRow {
  id: string;
  name: string;
  address: string;
  county: string;
  state: string;
  description?: string;
}
export function placeRows(e: Envelope): PlaceRow[] {
  if (e.status !== "ok" && e.status !== "partial" && e.status !== "degraded")
    return [];
  const out: PlaceRow[] = [];
  for (const r of (e.results ?? []) as Record<string, unknown>[]) {
    const p = (r.properties ?? {}) as Record<string, unknown>;
    const g = (p.geocode ?? {}) as Record<string, unknown>;
    if (typeof r.entity_id !== "string" || typeof r.name !== "string") continue;
    out.push({
      id: r.entity_id,
      name: r.name,
      address: typeof p.address === "string" ? p.address : "",
      county: typeof g.admin2_region === "string" ? g.admin2_region : "",
      state: typeof g.admin1_region === "string" ? g.admin1_region : "",
      description:
        typeof p.short_description === "string"
          ? p.short_description
          : undefined,
    });
  }
  return out;
}

export function cellRows(e: Envelope): CellRow[] {
  if (e.status !== "ok" && e.status !== "partial" && e.status !== "degraded")
    return [];
  const out: CellRow[] = [];
  for (const r of (e.results ?? []) as Record<string, unknown>[]) {
    const loc = r.location as { geohash?: unknown } | undefined;
    const q = (r.query ?? {}) as Record<string, unknown>;
    if (
      typeof loc?.geohash !== "string" ||
      !/^[0-9b-hjkmnp-z]{2,12}$/.test(loc.geohash)
    )
      continue;
    out.push({
      geohash: loc.geohash,
      affinityRank: num(q.affinity_rank),
      popularity: num(q.popularity),
    });
  }
  return out;
}

export function describeCandidates(e: Envelope): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const push = (c: Candidate) => {
    if (c.id && c.name && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  };
  if (e.status === "needs_input")
    for (const i of e.resolution?.issues ?? [])
      for (const c of i.candidates ?? []) push(c);
  const interp = (
    e.interpretation as {
      entity?: { entityId?: string; name?: string; type?: string };
    }
  )?.entity;
  for (const r of entityRows(e))
    push({
      id: r.id,
      name: r.name,
      type: interp?.entityId === r.id ? interp.type : r.type,
      popularity: r.popularity,
    });
  return out;
}
