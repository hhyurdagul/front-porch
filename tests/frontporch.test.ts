import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { EvidenceCache } from "../server/cache.js";
import { Gemini, numbersGrounded } from "../server/gemini.js";
import { geohashBounds, nearestState, pointInGeometry } from "../server/geo.js";
import { buildPlan, sameName } from "../server/pipeline.js";
import {
  Qloo,
  cellRows,
  describeCandidates,
  entityRows,
} from "../server/qloo.js";
import { exclusionReason } from "../server/wikidata.js";
import type { Plan, ProgressEvent } from "../shared/types.js";
import { FakeLlm, FakeQloo, TOP, fakeFetch } from "./fakes.js";

const deps = () => {
  const t = new FakeQloo();
  const llm = new FakeLlm();
  return {
    t,
    llm,
    deps: {
      qloo: new Qloo(t, 3, 0, [1, 1]),
      llm,
      fetch: fakeFetch,
      cache: new EvidenceCache(undefined),
      limits: { topCounties: 1 },
    },
  };
};

test("geohash decoding and point-in-polygon agree", () => {
  const g = geohashBounds("9y6");
  assert.ok(g.lat > 33 && g.lat < 37 && g.lon < -95 && g.lon > -100);
  const [[s, w], [n, e]] = g.bounds;
  const sq = {
    type: "Polygon" as const,
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
  assert.ok(pointInGeometry(g.lat, g.lon, sq));
  assert.ok(!pointInGeometry(g.lat + 5, g.lon, sq));
  assert.equal(nearestState(35.47, -97.52), "OK");
  assert.equal(nearestState(30.69, -88.04), "AL");
});

test("name matching rejects look-alike entities and accepts formatting differences", () => {
  assert.ok(
    sameName(
      "Oklahoma State University-Tulsa",
      "Oklahoma State University - Tulsa",
    ),
  );
  assert.ok(sameName("The Revivalists", "Revivalists"));
  assert.ok(!sameName("9news", "KWTV News 9"));
  assert.ok(!sameName("Newson's Bike & Skate Exchange Ltd.", "KOTV News On 6"));
});

test("religious and political entities are excluded", () => {
  assert.ok(exclusionReason("YouVersion Bible & Prayer"));
  assert.ok(exclusionReason("Life.Church"));
  assert.ok(exclusionReason("Someone", ["politician"]));
  assert.equal(
    exclusionReason("Oklahoma City Thunder", ["basketball team"]),
    undefined,
  );
});

test("model text may not introduce numbers missing from the evidence", () => {
  assert.ok(
    numbersGrounded("Your fans in Mobile County (risk 99)", { risk: 99 }),
  );
  assert.ok(!numbersGrounded("Reach 40,000 people", { risk: 99 }));
});

test("Gemini retries an overloaded model but not a bad request", async () => {
  const reply = (status: number) =>
    new Response(
      status === 200
        ? JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        partners: [{ name: "Mobile BayBears", kind: "team" }],
                      }),
                    },
                  ],
                },
              },
            ],
          })
        : "{}",
      { status },
    );
  const ask = {
    stateName: "Alabama",
    hazard: "hurricane" as const,
    counties: ["Mobile County"],
  };
  let calls = 0;
  const flaky = new Gemini("m", "k", (async () =>
    reply(++calls < 2 ? 503 : 200)) as typeof fetch);
  assert.deepEqual(await flaky.baseline(ask), [
    { name: "Mobile BayBears", kind: "team" },
  ]);
  assert.equal(calls, 2);
  calls = 0;
  const bad = new Gemini(
    "m",
    "k",
    (async () => (calls++, reply(400))) as typeof fetch,
  );
  await assert.rejects(bad.baseline(ask), /400/);
  assert.equal(calls, 1);
});

test("parsers keep only well-formed rows", () => {
  const e = {
    status: "ok",
    results: [
      { entity_id: "a", name: "A", subtype: "urn:entity:brand" },
      { entity_id: "a", name: "A" },
      { name: "no id" },
    ],
  } as never;
  assert.deepEqual(
    entityRows(e).map((r) => r.id),
    ["a"],
  );
  const c = {
    status: "ok",
    results: [
      { location: { geohash: "9y6pp" }, query: { affinity_rank: 0.9 } },
      { location: { geohash: "bad!" } },
    ],
  } as never;
  assert.equal(cellRows(c).length, 1);
  const d = {
    status: "needs_input",
    resolution: {
      issues: [
        {
          candidates: [
            { id: "1", name: "X" },
            { id: "1", name: "X" },
          ],
        },
      ],
    },
  } as never;
  assert.equal(describeCandidates(d).length, 1);
});

test("Qloo client validates inputs against the discovered schema before calling", async () => {
  const { t, deps: d } = deps();
  await assert.rejects(
    d.qloo.call("qloo_where_popular", { entity: "x" }),
    /does not match/,
  );
  assert.equal(t.calls.length, 0);
});

test("plan: local partners in risk counties, statewide tier, rejections, venues, and a checked baseline", async () => {
  const { llm, deps: d } = deps();
  const steps: string[] = [];
  const plan = await buildPlan(d, "OK", "tornado", (s) => steps.push(s));
  const by = (name: string) => plan.partners.find((p) => p.name === name)!;
  assert.equal(by("Thunder Test Team").status, "recommended");
  assert.equal(by("Thunder Test Team").footprint, 1);
  assert.deepEqual(by("Thunder Test Team").coveredCounties, ["Top"]);
  assert.equal(by("Local Singer Test").status, "recommended");
  assert.equal(by("Local Singer Test").kind, "artist");
  assert.equal(by("State University Test").status, "statewide");
  assert.equal(by("Texas Chain").status, "not-local");
  assert.match(by("Texas Chain").why, /TX/);
  assert.equal(by("Life Church Test").status, "excluded");
  assert.deepEqual(
    plan.venues.map((v) => v.name),
    ["Corner Diner"],
  ); // other county and church filtered
  const v = Object.fromEntries(plan.baseline.map((b) => [b.name, b.verdict]));
  assert.deepEqual(v, {
    "Thunder Test Team": "local",
    "Texas Chain": "not-local",
    "Dead Star": "deceased",
    "Gone Team (historic local team)": "defunct", // aside stripped before checking
    "Made Up Radio": "not-found",
    "Far Station": "not-found", // Qloo alone never calls a suggestion wrong
  });
  assert.equal(plan.scorecard.gemini.verifiedLocal, 1);
  assert.equal(
    plan.scorecard.gemini.deceased + plan.scorecard.gemini.defunct,
    2,
  );
  assert.equal(plan.invitations.length, 1);
  assert.ok(
    plan.invitations[0].body.includes(plan.officialMessage.text),
    "official text inserted verbatim",
  );
  assert.deepEqual(
    llm.invitations.map((i) => i.partner),
    ["Thunder Test Team"],
  ); // public figures get no draft
  for (const s of [
    "risk",
    "candidates",
    "locality",
    "footprint",
    "wikidata",
    "baseline",
    "invite",
  ])
    assert.ok(steps.includes(s), s);
  assert.ok(
    plan.trace.some((t) => t.source === "FEMA_NRI") &&
      plan.trace.some((t) => t.source === "WIKIDATA"),
  );
  assert.ok(
    plan.counties.find((c) => c.top)?.name === "Top" && TOP.length === 3,
  );
});

test("evidence cache: seeded answers are pinned and never expire", () => {
  const dir = mkdtempSync(join(tmpdir(), "fp-seed-"));
  const seed = join(dir, "seed.json");
  writeFileSync(
    seed,
    JSON.stringify({
      entries: [{ key: "k", at: "2026-10-20T18:00:00Z", value: [1] }],
    }),
  );
  const cache = new EvidenceCache(undefined, 1, seed);
  assert.deepEqual(cache.get("k"), {
    at: Date.parse("2026-10-20T18:00:00Z"),
    value: [1],
  });
  // 1 ms TTL, recorded days ago: an ordinary entry would be gone.
});

test("evidence cache: a repeated plan makes no new Qloo calls", async () => {
  const { t, deps: d } = deps();
  await buildPlan(d, "OK", "tornado");
  const n = t.calls.length;
  const again = await buildPlan(d, "OK", "tornado");
  assert.equal(t.calls.length, n);
  assert.ok(again.trace.some((x) => x.status === "ok (cached)"));
});

test("API streams progress then a plan, serves exports, and rejects bad input", async () => {
  const { deps: d } = deps();
  const { app } = createApp(d);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const bad = await fetch(`${base}/api/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "ZZ", hazard: "tornado" }),
    });
    assert.equal(bad.status, 400);
    const res = await fetch(`${base}/api/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "OK", hazard: "tornado" }),
    });
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as ProgressEvent);
    assert.ok(events.length > 3 && events.at(-1)!.type === "result");
    const plan = (events.at(-1) as { plan: Plan }).plan;
    const again = await fetch(`${base}/api/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "OK", hazard: "tornado" }),
    });
    assert.match(await again.text(), /"step":"cache"/);
    const html = await fetch(`${base}/api/plans/${plan.id}?format=html`);
    assert.match(await html.text(), /Front Porch outreach brief/);
    const csp = html.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.equal((await fetch(`${base}/api/plans/nope`)).status, 404);
  } finally {
    server.close();
  }
});

test("API: recorded demo plans load instantly, past the TTL and with no Qloo calls", async () => {
  const { t, deps: d } = deps();
  const demo = await buildPlan(d, "OK", "tornado");
  const n = t.calls.length;
  const { app } = createApp(
    d,
    {
      plansPerHourPerIp: 12,
      concurrentPlans: 2,
      planTtlMs: 1,
      timeoutMs: 240000,
    },
    [demo],
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/api/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "OK", hazard: "tornado" }),
    });
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as ProgressEvent);
    assert.equal(events[0].type === "progress" && events[0].step, "cache");
    assert.equal((events.at(-1) as { plan: Plan }).plan.id, demo.id);
    assert.equal(t.calls.length, n);
    const options = await (await fetch(`${base}/api/options`)).json();
    assert.ok(
      options.presets.some(
        (p: { state: string; ready: boolean }) => p.state === "OK" && p.ready,
      ),
    );
  } finally {
    server.close();
  }
});
