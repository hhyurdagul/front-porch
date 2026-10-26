import { randomUUID } from "node:crypto";
import {
  HAZARDS,
  type BaselineRow,
  type Cell,
  type County,
  type HazardId,
  type Invitation,
  type Partner,
  type PartnerKind,
  type Plan,
  type Scorecard,
  type Venue,
  type TraceEntry,
  type WikidataCheck,
} from "../shared/types.js";
import { EvidenceCache } from "./cache.js";
import { OFFICIAL, type Llm } from "./gemini.js";
import { STATES, geohashBounds, nearestState, pointInGeometry } from "./geo.js";
import { countiesByRisk } from "./nri.js";
import type { CellRow, EntityRow, Qloo } from "./qloo.js";
import { checkEntity, exclusionReason } from "./wikidata.js";

export interface Deps {
  qloo: Qloo;
  llm: Llm;
  cache?: EvidenceCache;
  fetch?: typeof fetch;
  limits?: Partial<{ topCounties: number; candidates: number }>;
}
type Progress = (step: string, detail?: string) => void;

export const LOCAL_SHARE = 0.5; // ≥ half of an entity's US-wide affinity cells must lie in the state
export const RISK_FOOTPRINT = 0.25; // ≥ a quarter of its in-state following must lie in the top-risk counties

export async function buildPlan(
  deps: Deps,
  state: string,
  hazard: HazardId,
  progress: Progress = () => {},
  signal?: AbortSignal,
): Promise<Plan> {
  const stateName = STATES[state];
  const lim = { topCounties: 4, candidates: 28, ...deps.limits };
  const cache = deps.cache ?? new EvidenceCache();
  const f = deps.fetch ?? fetch;
  const trace: TraceEntry[] = [];
  const warnings: string[] = [];
  const check = () => signal?.throwIfAborted();

  /** Run one upstream request through the evidence cache and record it in the trace. */
  async function ev<T>(
    source: TraceEntry["source"],
    tool: string,
    input: Record<string, unknown>,
    key: string | undefined,
    fn: () => Promise<T>,
    summarize: (r: T) => string,
  ): Promise<T | undefined> {
    const t0 = Date.now();
    try {
      const { value, cachedAt } = key
        ? await cache.through(key, fn)
        : { value: await fn(), cachedAt: undefined };
      trace.push({
        id: randomUUID(),
        source,
        tool,
        input,
        status: cachedAt ? "ok (cached)" : "ok",
        summary:
          summarize(value) +
          (cachedAt
            ? ` · fetched ${new Date(cachedAt).toISOString().slice(0, 16)}Z`
            : ""),
        ms: Date.now() - t0,
        at: new Date().toISOString(),
      });
      return value;
    } catch (e) {
      trace.push({
        id: randomUUID(),
        source,
        tool,
        input,
        status: "error",
        summary: e instanceof Error ? e.message : "failed",
        ms: Date.now() - t0,
        at: new Date().toISOString(),
      });
      return undefined;
    }
  }

  // 1. Where is the risk? FEMA National Risk Index by county.
  progress(
    "risk",
    `Reading FEMA National Risk Index: ${HAZARDS[hazard].label.toLowerCase()} risk by county in ${stateName}`,
  );
  const counties = await ev(
    "FEMA_NRI",
    "county risk scores",
    { state, hazard },
    `nri:${state}:${hazard}`,
    () => countiesByRisk(state, hazard, lim.topCounties, f),
    (c) =>
      `${c.length} counties; highest: ${c
        .filter((x) => x.top)
        .map((x) => `${x.name} ${x.risk.toFixed(1)}`)
        .join(", ")}`,
  );
  if (!counties)
    throw new Error("FEMA National Risk Index is unavailable right now.");
  const top = counties.filter((c) => c.top);
  const askedP = ev(
    "GEMINI",
    "baseline partners",
    { stateName, hazard, counties: top.map((c) => c.name) },
    `gemini:baseline:${deps.llm.name}:${state}:${hazard}:${top.map((c) => c.name).join("|")}`,
    () =>
      deps.llm.baseline({
        stateName,
        hazard,
        counties: top.map((c) => `${c.name} ${c.kind}`),
      }),
    (r) => r.map((x) => x.name).join(", "),
  );
  check();

  // 2. Who has a following there? Qloo recommendations anchored on each high-risk county.
  progress(
    "candidates",
    `Asking Qloo which teams, schools, businesses and artists over-index around ${top.length} highest-risk counties`,
  );
  const lists: {
    county: County;
    target: "brand" | "artist";
    rows: EntityRow[];
  }[] = [];
  await mapLimit(
    top.flatMap((c) =>
      (["brand", "artist"] as const).map((target) => ({ c, target })),
    ),
    3,
    async ({ c, target }) => {
      const place = `${c.name} ${c.kind}, ${stateName}`;
      const rows = await ev(
        "QLOO",
        "qloo_recommend",
        { target_type: target, signal_location: place },
        `rec:${target}:${place}`,
        async () => (await deps.qloo.recommendNear(target, place)).rows,
        (r) =>
          `${r.length}: ${r
            .slice(0, 6)
            .map((x) => x.name)
            .join(", ")}`,
      );
      lists.push({ county: c, target, rows: rows ?? [] });
      progress(
        "candidates",
        `Qloo listed ${rows?.length ?? 0} ${target === "brand" ? "organisations" : "artists"} around ${place}`,
      );
    },
  );
  lists.sort(
    (a, b) => b.county.risk - a.county.risk || a.target.localeCompare(b.target),
  );
  check();

  // 2b. Local venues inside each high-risk county that fit its taste profile (Qloo geocode confirms the county).
  const venues: Venue[] = [];
  await mapLimit(top, 3, async (c) => {
    const place = `${c.name} ${c.kind}, ${stateName}`;
    const rows = await ev(
      "QLOO",
      "qloo_recommend",
      { target_type: "place", signal_location: place, filter_location: place },
      `places:${place}`,
      async () => (await deps.qloo.placesIn(place)).rows,
      (r) =>
        `${r.length}: ${r
          .slice(0, 5)
          .map((x) => x.name)
          .join(", ")}`,
    );
    const norm = (x: string) =>
      x
        .toLowerCase()
        .replace(/\b(county|parish|borough)\b/g, "")
        .trim();
    for (const r of rows ?? []) {
      if (norm(r.county) !== norm(c.name) || r.state !== stateName) continue;
      if (exclusionReason(r.name, [], r.description ?? "")) continue;
      venues.push({
        id: r.id,
        name: r.name,
        county: c.name,
        address: r.address,
        description: r.description,
      });
    }
    progress(
      "candidates",
      `Qloo found ${venues.filter((v) => v.county === c.name).length} local venues in ${place}`,
    );
  });
  venues.sort(
    (a, b) =>
      top.findIndex((c) => c.name === a.county) -
      top.findIndex((c) => c.name === b.county),
  );

  // 3. Candidate pool: round-robin by rank across county lists, so every county's most distinctive names get tested.
  const found = new Map<string, string[]>();
  for (const l of lists)
    for (const r of l.rows)
      found.set(r.id, [
        ...new Set([...(found.get(r.id) ?? []), l.county.name]),
      ]);
  const byId = new Map(
    lists.flatMap((l) => l.rows.map((r) => [r.id, r] as const)),
  );
  const order: string[] = [];
  for (let i = 0; i < 20; i++)
    for (const l of lists)
      if (l.rows[i] && !order.includes(l.rows[i].id)) order.push(l.rows[i].id);
  const excluded: Partner[] = [];
  const candidates: EntityRow[] = [];
  for (const id of order) {
    const r = byId.get(id)!;
    const why = exclusionReason(r.name);
    if (why)
      excluded.push(blank(r, found.get(id)!, "excluded", `Excluded: ${why}`));
    else if (candidates.length < lim.candidates) candidates.push(r);
  }

  // 4. Locality test: does the entity's US-wide affinity concentrate in this state?
  async function locality(id: string, name: string) {
    const cells = await ev(
      "QLOO",
      "qloo_where_popular",
      { entity: id, label: name, within: "United States" },
      `us:${id}`,
      async () => (await deps.qloo.wherePopular(id, "United States")).cells,
      (c) =>
        `${c.length} cells; ${statesOf(c)
          .map(([s, n]) => `${s} ${n}`)
          .join(", ")}`,
    );
    if (!cells?.length)
      return { share: 0, states: [] as [string, number][], failed: true };
    const states = statesOf(cells);
    return {
      share: (states.find(([s]) => s === state)?.[1] ?? 0) / cells.length,
      states: states.slice(0, 3),
      failed: false,
    };
  }
  const partners: Partner[] = [];
  let n = 0;
  await mapLimit(candidates, 3, async (c) => {
    const loc = await locality(c.id, c.name);
    progress(
      "locality",
      `Locality test ${++n}/${candidates.length}: ${c.name} → ${loc.failed ? "no map" : loc.states.map(([s, k]) => `${s} ${k}`).join(", ")}`,
    );
    const p = blank(
      c,
      found.get(c.id)!,
      loc.share >= LOCAL_SHARE ? "unverified" : "not-local",
      loc.failed
        ? "Qloo has no US map for this entity"
        : loc.share >= LOCAL_SHARE
          ? ""
          : `Following concentrates in ${loc.states.map(([s]) => s).join("/") || "no state"}, not ${state}`,
    );
    Object.assign(p, {
      homeShare: loc.share,
      homeStates: loc.states,
      local: loc.share >= LOCAL_SHARE,
    });
    partners.push(p);
    check();
  });
  partners.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  // 5. Footprint: how much of each local partner's in-state following sits in the highest-risk counties?
  const local = partners.filter((p) => p.local);
  progress(
    "footprint",
    `Mapping ${local.length} local followings across ${stateName}`,
  );
  await mapLimit(local, 3, async (p) => {
    const cells = await ev(
      "QLOO",
      "qloo_where_popular",
      { entity: p.id, label: p.name, within: stateName },
      `in:${state}:${p.id}`,
      async () => (await deps.qloo.wherePopular(p.id, stateName)).cells,
      (c) => `${c.length} cells`,
    );
    if (cells) Object.assign(p, footprint(cells, counties));
    else warnings.push(`Qloo could not map ${p.name} within ${stateName}.`);
  });
  check();

  // 6. Independent check: Wikidata place (HQ, home venue, origin, birthplace), death and dissolution dates.
  progress(
    "wikidata",
    "Checking local partners against Wikidata: based in the state? still active?",
  );
  await mapLimit(local, 4, async (p) => {
    p.wikidata = (await ev(
      "WIKIDATA",
      "entity lookup",
      { name: p.name, state },
      `wd:${state}:${p.name}`,
      () => checkEntity(p.name, state, f),
      wdSummary,
    )) ?? { instanceOf: [] };
  });
  for (const p of local) {
    p.kind = classify(p.qlooType, p.wikidata);
    const gone =
      p.wikidata.excluded ??
      (p.wikidata.died && `died ${p.wikidata.died}`) ??
      (p.wikidata.defunct && `defunct since ${p.wikidata.defunct}`);
    if (gone) {
      p.status = "excluded";
      p.why = `Excluded: ${gone} (Wikidata)`;
      continue;
    }
    const org = p.kind !== "artist" && p.kind !== "person";
    p.score =
      (0.55 * p.footprint + 0.25 * (p.riskWeighted / 100) + 0.2 * p.homeShare) *
      (org ? 1 : 0.85);
    p.status = p.footprint >= RISK_FOOTPRINT ? "recommended" : "statewide";
    p.why = explain(p, top, stateName);
  }
  const ranked = [
    ...partners
      .filter((p) => p.status === "recommended")
      .sort((a, b) => b.score - a.score),
    ...partners
      .filter((p) => p.status === "statewide")
      .sort((a, b) => b.score - a.score),
    ...partners.filter((p) => p.status === "excluded"),
    ...partners.filter((p) => p.status === "not-local"),
    ...excluded,
  ];

  // 7. The same question asked to Gemini alone (started in step 1 so the model runs alongside Qloo work).
  progress(
    "baseline",
    `Checking ${deps.llm.name}'s answer to the same question, asked with no Qloo data`,
  );
  const asked = (await askedP) ?? [];
  const baselineError = asked.length
    ? undefined
    : (trace.find((t) => t.tool === "baseline partners")?.summary ??
      "No answer.");
  const baseline: BaselineRow[] = new Array(asked.length);
  let m = 0;
  await mapLimit(
    asked.map((b, i) => ({ b, i })),
    3,
    async ({ b, i }) => {
      baseline[i] = await judgeBaseline(b);
      progress(
        "baseline",
        `Checked Gemini's suggestion ${++m}/${asked.length}: ${b.name} → ${baseline[i].verdict}`,
      );
      check();
    },
  );
  async function judgeBaseline(asked: {
    name: string;
    kind: string;
  }): Promise<BaselineRow> {
    // Models add asides like "Mobile BayBears (historic/local sports community)"; check the name itself.
    const b = {
      ...asked,
      name: asked.name.replace(/\s*\([^)]*\)/g, "").trim() || asked.name,
    };
    const wd = (await ev(
      "WIKIDATA",
      "entity lookup",
      { name: b.name, state },
      `wd:${state}:${b.name}`,
      () => checkEntity(b.name, state, f),
      wdSummary,
    )) ?? { instanceOf: [] };
    const row: BaselineRow = {
      name: asked.name,
      claimedKind: b.kind,
      wikidata: wd,
      verdict: "not-found",
      note: "",
    };
    const wdNote = wd.place
      ? `Wikidata: ${wd.place}${wd.inState ? ` (in ${stateName})` : ` (outside ${stateName})`}`
      : "";
    const why = wd.excluded ?? exclusionReason(b.name);
    if (why) return { ...row, verdict: "excluded", note: why };
    if (wd.died)
      return {
        ...row,
        verdict: "deceased",
        note: `Wikidata: ${wd.description ?? b.name}, died ${wd.died}`,
      };
    if (wd.defunct)
      return {
        ...row,
        verdict: "defunct",
        note: `Wikidata: dissolved ${wd.defunct}. ${wdNote}`,
      };
    const cands =
      (await ev(
        "QLOO",
        "qloo_describe",
        { entity: b.name },
        `desc:${b.name}`,
        async () => (await deps.qloo.describe(b.name)).candidates,
        (c) =>
          c
            .slice(0, 3)
            .map((x) => `${x.name} (${(x.type ?? "").split(":").pop()})`)
            .join(", ") || "no match",
      )) ?? [];
    const named = cands.filter((c) => sameName(c.name, b.name));
    const pick =
      named.find((c) =>
        /:(brand|artist|podcast|tv_show)$/.test(c.type ?? ""),
      ) ?? named.find((c) => /:(person|place)$/.test(c.type ?? ""));
    const loc = pick ? await locality(pick.id, pick.name) : undefined;
    if (pick && loc && !loc.failed) {
      const hot = `Qloo hotspots: ${loc.states.map(([s, k]) => `${s} ${k}/20`).join(", ")}`;
      Object.assign(row, {
        qlooId: pick.id,
        qlooName: pick.name,
        homeShare: loc.share,
        homeStates: loc.states,
      });
      if (loc.share >= LOCAL_SHARE)
        return {
          ...row,
          verdict: "local",
          note: [hot, wdNote].filter(Boolean).join("; "),
        };
      if (wd.inState)
        return {
          ...row,
          verdict: "mixed",
          note: `${hot}; ${wdNote}: the two sources disagree`,
        };
      // Qloo alone is not enough to call a suggestion wrong (its maps for local media are thin):
      // "not local" needs Wikidata to place it outside the state as well.
      if (wd.place)
        return {
          ...row,
          verdict: "not-local",
          note: [hot, wdNote].filter(Boolean).join("; "),
        };
      return {
        ...row,
        verdict: "not-found",
        note: `${hot}, but Wikidata has no location to confirm it`,
      };
    }
    if (wd.inState)
      return {
        ...row,
        verdict: "wikidata-local",
        note: `Not mapped by Qloo; ${wdNote}`,
      };
    if (wd.place)
      return {
        ...row,
        verdict: "not-local",
        note: `Not mapped by Qloo; ${wdNote}`,
      };
    return {
      ...row,
      note: named.length
        ? "In Qloo, but without a US map"
        : cands.length
          ? `No Qloo entity with this name (closest: ${cands[0].name})`
          : "Not found in Qloo or Wikidata",
    };
  }
  const shown = ranked.filter((p) => p.status === "recommended").slice(0, 10);
  const scorecard = {
    qloo: score(
      shown.map((p) => ({ verdict: "local", wdIn: !!p.wikidata.inState })),
    ),
    gemini: score(
      baseline.map((b) => ({ verdict: b.verdict, wdIn: !!b.wikidata.inState })),
    ),
  };

  // 8. Draft invitations for the top three; the official message is inserted verbatim by code.
  const official = OFFICIAL[hazard];
  // Public figures need a human check of their record before any outreach, so only organisations get drafts.
  const orgs = shown.filter((p) => p.kind !== "artist" && p.kind !== "person");
  const invitations: Invitation[] = [];
  progress(
    "invite",
    `Drafting invitations to the top ${Math.min(3, orgs.length)} organisations (human review required)`,
  );
  await mapLimit(orgs.slice(0, 3), 3, async (p) => {
    const facts = {
      partner: p.name,
      partnerKind: p.kind,
      stateName,
      hazard: HAZARDS[hazard].label,
      counties: top
        .filter((c) => p.coveredCounties.includes(c.name))
        .map((c) => ({
          name: `${c.name} ${c.kind}`,
          risk: Math.round(c.risk),
        })),
      evidence: [p.why],
    };
    let parts = await ev(
      "GEMINI",
      "invitation draft",
      { partner: p.name },
      undefined,
      () => deps.llm.invitation(facts),
      () => "draft",
    );
    if (!parts) {
      warnings.push(
        `Invitation to ${p.name} uses the plain template (the model draft was missing or added unsupported numbers).`,
      );
      parts = {
        subject: `Invitation: help ${stateName} prepare for ${HAZARDS[hazard].label.toLowerCase()} season`,
        opening: `Hello ${p.name} team,\n\nWe are preparing for ${HAZARDS[hazard].label.toLowerCase()} season, and your community reaches many of the people we most need to reach. Would you be willing to share this official message with your audience?`,
        closing:
          "If you are open to it, we would be glad to provide graphics and talk through timing. Thank you for considering it.\n\n[Your name]\n[Your office]",
      };
    }
    invitations.push({
      partnerId: p.id,
      subject: parts.subject,
      body: `${parts.opening}\n\n"${official.text}"\n(Source: National Weather Service, ${official.source})\n\n${parts.closing}`,
    });
  });
  invitations.sort(
    (a, b) =>
      shown.findIndex((p) => p.id === a.partnerId) -
      shown.findIndex((p) => p.id === b.partnerId),
  );

  const g = scorecard.gemini;
  const summary =
    `${orgs.length} organisation${orgs.length === 1 ? "" : "s"} and ${shown.length - orgs.length} public figure${shown.length - orgs.length === 1 ? "" : "s"} have a local following concentrated in the highest-risk counties (${top.map((c) => c.name).join(", ")}), plus ${venues.length} local venues that fit those counties' taste. ` +
    (baselineError
      ? `${deps.llm.name} alone gave no list to compare (${baselineError}).`
      : `Gemini alone suggested ${g.total}: ${g.verifiedLocal} confirmed local by Qloo, ${g.wikidataOnlyLocal} local per Wikidata only, ` +
        `${g.notLocal} not local, ${g.mixed} with conflicting evidence, ${g.deceased + g.defunct} deceased or defunct, ${g.notFound} unverifiable.`);
  return {
    id: randomUUID(),
    state,
    stateName,
    hazard,
    createdAt: new Date().toISOString(),
    model: deps.llm.name,
    counties,
    partners: ranked,
    venues,
    baseline,
    baselineError,
    scorecard,
    officialMessage: official,
    invitations,
    summary,
    trace,
    warnings,
  };
}

function blank(
  r: EntityRow,
  foundIn: string[],
  status: Partner["status"],
  why: string,
): Partner {
  return {
    id: r.id,
    name: r.name,
    qlooType: r.type,
    kind: "other",
    foundIn,
    homeShare: 0,
    homeStates: [],
    footprint: 0,
    riskWeighted: 0,
    coveredCounties: [],
    cells: [],
    wikidata: { instanceOf: [] },
    local: false,
    score: 0,
    status,
    why,
  };
}

function statesOf(cells: CellRow[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const c of cells) {
    const g = geohashBounds(c.geohash);
    const s = nearestState(g.lat, g.lon);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const wdSummary = (w: WikidataCheck) =>
  w.qid
    ? `${w.qid}${w.place ? `, ${w.place}` : ""}${w.inState ? " (in state)" : ""}${w.died ? `, died ${w.died}` : ""}${w.defunct ? `, dissolved ${w.defunct}` : ""}`
    : "no match";

export function footprint(cells: CellRow[], counties: County[]) {
  let w = 0;
  let wTop = 0;
  let wRisk = 0;
  const covered = new Set<string>();
  const out: Cell[] = [];
  for (const c of cells) {
    const g = geohashBounds(c.geohash);
    const county = counties.find((k) =>
      pointInGeometry(g.lat, g.lon, k.geometry),
    );
    out.push({
      geohash: c.geohash,
      lat: g.lat,
      lon: g.lon,
      bounds: g.bounds,
      affinityRank: c.affinityRank,
      popularity: c.popularity,
      county: county?.fips,
    });
    if (!county) continue;
    const wt = c.affinityRank > 0 ? c.affinityRank : 1;
    w += wt;
    wRisk += wt * county.risk;
    if (county.top) {
      wTop += wt;
      covered.add(county.name);
    }
  }
  return {
    cells: out,
    footprint: w ? wTop / w : 0,
    riskWeighted: w ? wRisk / w : 0,
    coveredCounties: [...covered],
  };
}

export function classify(qlooType: string, wd: WikidataCheck): PartnerKind {
  const t = [qlooType, ...wd.instanceOf, wd.description ?? ""]
    .join(" ")
    .toLowerCase();
  if (
    /sports team|basketball team|football (club|team)|soccer|baseball team|hockey team|sports club|franchise/.test(
      t,
    )
  )
    return "team";
  if (/university|college|school/.test(t)) return "university";
  if (/radio|television|newspaper|broadcast|news|magazine|media/.test(t))
    return "media";
  if (/nonprofit|non-profit|charit|foundation|association/.test(t))
    return "nonprofit";
  if (/band|musical group|musician|singer|rapper|:artist/.test(t))
    return "artist";
  if (/human|person/.test(t)) return "person";
  if (/company|business|enterprise|restaurant|chain|retail|brand|store/.test(t))
    return "business";
  return "other";
}

function explain(p: Partner, top: County[], stateName: string) {
  const inState = p.homeStates.find(([s]) => STATES[s] === stateName)?.[1];
  const lead = `${inState ?? Math.round(p.homeShare * 20)} of its 20 strongest US Qloo hotspots are in ${stateName}`;
  const cov =
    p.status === "statewide"
      ? `, but only ${Math.round(p.footprint * 100)}% of its in-state following lies in the highest-risk counties`
      : `; ${Math.round(p.footprint * 100)}% of its in-state following lies in ${p.coveredCounties.length} of ${top.length} highest-risk counties (${p.coveredCounties.join(", ")})`;
  const wd = p.wikidata.place
    ? `; Wikidata: ${p.wikidata.place}${p.wikidata.inState ? ` (in ${stateName})` : ""}`
    : "";
  return lead + cov + wd;
}

/** Same entity name after normalising case, accents, punctuation, "the" and corporate suffixes. */
export function sameName(a: string, b: string) {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/&/g, " and ")
      .replace(/\b(the|inc|llc|co|corp|company)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const tx = new Set(x.split(" "));
  const ty = new Set(y.split(" "));
  const common = [...tx].filter((t) => ty.has(t)).length;
  return common / Math.max(tx.size, ty.size) >= 0.8;
}

function score(rows: { verdict: string; wdIn: boolean }[]): Scorecard {
  const c = (v: string) => rows.filter((r) => r.verdict === v).length;
  return {
    total: rows.length,
    verifiedLocal: c("local"),
    wikidataOnlyLocal: c("wikidata-local"),
    notLocal: c("not-local"),
    mixed: c("mixed"),
    deceased: c("deceased"),
    defunct: c("defunct"),
    notFound: c("not-found"),
    excluded: c("excluded"),
    wikidataInState: rows.filter((r) => r.wdIn).length,
  };
}

export async function mapLimit<T>(
  items: T[],
  n: number,
  fn: (x: T) => Promise<void>,
) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}
