// Offline stand-ins for Qloo (MCP transport), FEMA, Wikidata and Gemini. Envelopes follow the
// discovered harness output schemas, so the real validation and parsing code runs unchanged.
import { geohashBounds } from "../server/geo.js";
import type { Envelope, QlooTransport } from "../server/qloo.js";
import type { InvitationFacts, Llm } from "../server/gemini.js";

const exec = {
  transport: "mcp",
  transport_name: "TEST",
  correlation_id: "test",
  duration_ms: 1,
};
const env = (
  operation: string,
  status: Envelope["status"],
  extra: object = {},
): Envelope =>
  ({
    schema_version: "1.0-preview.1",
    operation,
    status,
    execution: exec,
    ...extra,
  }) as Envelope;

// Two counties in "Oklahoma": TOP (geohash 9y6, high risk) and LOW (geohash 9y3, low risk).
export const TOP = "9y6";
export const LOW = "9y3";
const square = (g: string) => {
  const [[s, w], [n, e]] = geohashBounds(g).bounds;
  return {
    type: "Polygon",
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
};
const cells = (prefix: string, n: number, rank = 0.99) =>
  Array.from({ length: n }, (_, i) => ({
    location: { geohash: prefix + "0123456789bcdefghjkmnpqrstuvwxyz"[i] + "p" },
    query: { affinity_rank: rank, popularity: 0.9 },
  }));

/** Entities: e-team (local, in risk county), e-uni (local, low-risk county), e-chain (Texas), e-church (excluded). */
export class FakeQloo implements QlooTransport {
  calls: { tool: string; args: Record<string, unknown> }[] = [];
  async call(tool: string, args: Record<string, unknown>): Promise<Envelope> {
    this.calls.push({ tool, args });
    if (tool === "qloo_recommend" && args.target_type === "place")
      return env("recommend", "ok", {
        results: [
          {
            entity_id: "v1",
            name: "Corner Diner",
            properties: {
              address: "1 Main St",
              geocode: {
                admin2_region: "Top County",
                admin1_region: "Oklahoma",
              },
            },
          },
          {
            entity_id: "v2",
            name: "Elsewhere Cafe",
            properties: {
              address: "9 Far Rd",
              geocode: {
                admin2_region: "Other County",
                admin1_region: "Oklahoma",
              },
            },
          },
          {
            entity_id: "v3",
            name: "First Church",
            properties: {
              address: "2 Main St",
              geocode: {
                admin2_region: "Top County",
                admin1_region: "Oklahoma",
              },
            },
          },
        ],
      });
    if (tool === "qloo_recommend")
      return env("recommend", "ok", {
        results:
          args.target_type === "brand"
            ? [
                {
                  entity_id: "e-team",
                  name: "Thunder Test Team",
                  subtype: "urn:entity:brand",
                  popularity: 0.9,
                },
                {
                  entity_id: "e-chain",
                  name: "Texas Chain",
                  subtype: "urn:entity:brand",
                  popularity: 0.95,
                },
                {
                  entity_id: "e-church",
                  name: "Life Church Test",
                  subtype: "urn:entity:brand",
                  popularity: 0.9,
                },
                {
                  entity_id: "e-uni",
                  name: "State University Test",
                  subtype: "urn:entity:brand",
                  popularity: 0.9,
                },
              ]
            : [
                {
                  entity_id: "e-team",
                  name: "Thunder Test Team",
                  subtype: "urn:entity:brand",
                  popularity: 0.9,
                },
                {
                  entity_id: "e-singer",
                  name: "Local Singer Test",
                  subtype: "urn:entity:artist",
                  popularity: 0.8,
                },
              ],
      });
    if (tool === "qloo_where_popular") {
      const id = String(args.entity);
      const us = args.within === "United States";
      if (id === "e-chain")
        return env("where_popular", "ok", { results: cells("9vg", 20) }); // Dallas area
      if (id === "e-team" || id === "q-local" || id === "e-singer")
        return env("where_popular", "ok", {
          results: cells(TOP, us ? 20 : 18),
        });
      if (id === "e-uni")
        return env("where_popular", "ok", { results: cells(LOW, 20) });
      return env("where_popular", "error", {
        error: {
          code: "QLOO_CONTRACT",
          layer: "qloo",
          retryable: false,
          recovery: "x",
        },
      });
    }
    if (tool === "qloo_describe") {
      const name = String(args.entity);
      if (name === "Thunder Test Team")
        return env("describe", "ok", {
          interpretation: {
            entity: { entityId: "q-local", type: "urn:entity:brand" },
          },
          results: [{ entity_id: "q-local", name, popularity: 0.9 }],
        });
      if (name === "Texas Chain" || name === "Far Station")
        return env("describe", "ok", {
          results: [
            {
              entity_id: "e-chain",
              name,
              subtype: "urn:entity:brand",
              popularity: 0.9,
            },
          ],
        });
      return env("describe", "needs_input", {
        resolution: {
          issues: [
            {
              input: name,
              kind: "ambiguous",
              field: "entity",
              candidates: [
                { id: "x9", name: "Something Else", type: "urn:entity:place" },
              ],
            },
          ],
        },
      });
    }
    throw new Error(`unexpected tool ${tool}`);
  }
  async close() {}
}

export const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("National_Risk_Index_Counties"))
    return Response.json({
      features: [
        {
          properties: {
            STCOFIPS: "40001",
            COUNTY: "Top",
            COUNTYTYPE: "County",
            POPULATION: 1000,
            TRND_RISKS: 99.5,
            TRND_RISKR: "Very High",
          },
          geometry: square(TOP),
        },
        {
          properties: {
            STCOFIPS: "40002",
            COUNTY: "Low",
            COUNTYTYPE: "County",
            POPULATION: 500,
            TRND_RISKS: 10,
            TRND_RISKR: "Very Low",
          },
          geometry: square(LOW),
        },
      ],
    });
  if (url.includes("query.wikidata.org")) {
    const q = new URL(url).searchParams.get("query") ?? "";
    const label = /VALUES \?label \{ "([^"]+)"@en/.exec(q)?.[1] ?? "";
    const row: Record<string, { value: string }> = {
      item: { value: "http://www.wikidata.org/entity/Q1" },
    };
    if (label === "Thunder Test Team")
      Object.assign(row, {
        place: { value: "Oklahoma City" },
        local: { value: "1" },
        insts: { value: "basketball team" },
      });
    else if (label === "Dead Star")
      Object.assign(row, {
        d: { value: "2024-02-05T00:00:00Z" },
        desc: { value: "American singer" },
        insts: { value: "human" },
      });
    else if (label === "Texas Chain")
      Object.assign(row, {
        place: { value: "Dallas" },
        local: { value: "0" },
        insts: { value: "business" },
      });
    else if (label === "Gone Team")
      Object.assign(row, {
        g: { value: "2019-01-01T00:00:00Z" },
        insts: { value: "baseball team" },
      });
    else return Response.json({ results: { bindings: [] } });
    return Response.json({ results: { bindings: [row] } });
  }
  return new Response("not found", { status: 404 });
};

export class FakeLlm implements Llm {
  name = "fake-llm";
  invitations: InvitationFacts[] = [];
  async baseline() {
    return [
      { name: "Thunder Test Team", kind: "team" },
      { name: "Texas Chain", kind: "business" },
      { name: "Dead Star", kind: "musician" },
      { name: "Gone Team (historic local team)", kind: "team" },
      { name: "Made Up Radio", kind: "media" },
      { name: "Far Station", kind: "media" },
    ];
  }
  async invitation(f: InvitationFacts) {
    this.invitations.push(f);
    return {
      subject: `Join us, ${f.partner}`,
      opening: `Hello ${f.partner},`,
      closing: "Thanks, [Your name]",
    };
  }
}
