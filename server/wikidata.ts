import type { WikidataCheck } from "../shared/types.js";

// Public Wikidata Query Service: an external check on locality and on whether a person is alive.
const ENDPOINT = "https://query.wikidata.org/sparql";
const UA =
  "FrontPorch/0.1 (Qloo hackathon prototype; https://frontporch-556860386135.europe-west1.run.app)";

const STATE_QID: Record<string, string> = {
  AL: "Q173",
  AK: "Q797",
  AZ: "Q816",
  AR: "Q1612",
  CA: "Q99",
  CO: "Q1261",
  CT: "Q779",
  DE: "Q1393",
  FL: "Q812",
  GA: "Q1428",
  HI: "Q782",
  ID: "Q1221",
  IL: "Q1204",
  IN: "Q1415",
  IA: "Q1546",
  KS: "Q1558",
  KY: "Q1603",
  LA: "Q1588",
  ME: "Q724",
  MD: "Q1391",
  MA: "Q771",
  MI: "Q1166",
  MN: "Q1527",
  MS: "Q1494",
  MO: "Q1581",
  MT: "Q1212",
  NE: "Q1553",
  NV: "Q1227",
  NH: "Q759",
  NJ: "Q1408",
  NM: "Q1522",
  NY: "Q1384",
  NC: "Q1454",
  ND: "Q1207",
  OH: "Q1397",
  OK: "Q1649",
  OR: "Q824",
  PA: "Q1400",
  RI: "Q1387",
  SC: "Q1456",
  SD: "Q1211",
  TN: "Q1509",
  TX: "Q1439",
  UT: "Q829",
  VT: "Q16551",
  VA: "Q1370",
  WA: "Q1223",
  WV: "Q1371",
  WI: "Q1537",
  WY: "Q1214",
};

const RELIGIOUS =
  /\b(church|bible|prayer|ministr|pastor|sermon|gospel|christian|jesus|faith|worship|congregation|mosque|synagogue|temple|evangel|youversion)\w*/i;
const POLITICAL =
  /\b(political party|politician|republican|democrat|campaign|senator|governor|congress|caucus|pac)\b/i;

export function exclusionReason(
  name: string,
  instanceOf: string[] = [],
  description = "",
) {
  const text = [name, description, ...instanceOf].join(" ");
  if (RELIGIOUS.test(text)) return "religious organisation or content";
  if (POLITICAL.test(text)) return "political figure or organisation";
  return undefined;
}

function esc(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Look up an entity by its English label and test its places against the target state. */
export async function checkEntity(
  name: string,
  state: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WikidataCheck> {
  const st = STATE_QID[state];
  const q = `SELECT ?item ?desc (GROUP_CONCAT(DISTINCT ?instL; separator="|") AS ?insts) (SAMPLE(?death) AS ?d) (SAMPLE(?gone) AS ?g)
    (SAMPLE(?placeL) AS ?place) (MAX(?inSt) AS ?local) (SAMPLE(?sl) AS ?links) WHERE {
    VALUES ?label { "${esc(name)}"@en }
    ?item rdfs:label ?label .
    OPTIONAL { ?item schema:description ?desc FILTER(lang(?desc)="en") }
    OPTIONAL { ?item wdt:P31 ?inst . ?inst rdfs:label ?instL FILTER(lang(?instL)="en") }
    OPTIONAL { ?item wdt:P570 ?death }
    OPTIONAL { ?item wdt:P576 ?gone }
    OPTIONAL { ?item wikibase:sitelinks ?sl }
    OPTIONAL { ?item (wdt:P159|wdt:P115|wdt:P740|wdt:P19|wdt:P131|wdt:P276) ?p .
               ?p rdfs:label ?placeL FILTER(lang(?placeL)="en")
               OPTIONAL { ?p wdt:P131* wd:${st} . BIND(1 AS ?inSt) } }
  } GROUP BY ?item ?desc ORDER BY DESC(?local) DESC(?links) LIMIT 1`;
  try {
    const r = await fetchImpl(
      `${ENDPOINT}?${new URLSearchParams({ query: q, format: "json" })}`,
      {
        headers: {
          "user-agent": UA,
          accept: "application/sparql-results+json",
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) return { instanceOf: [] };
    const b = (await r.json()) as {
      results: { bindings: Record<string, { value: string }>[] };
    };
    const x = b.results.bindings[0];
    if (!x?.item) return { instanceOf: [] };
    const instanceOf = (x.insts?.value ?? "")
      .split("|")
      .filter(Boolean)
      .slice(0, 4);
    const description = x.desc?.value;
    return {
      qid: x.item.value.split("/").pop(),
      description,
      instanceOf,
      place: x.place?.value,
      inState: x.local?.value === "1",
      died: x.d?.value?.slice(0, 10),
      defunct: x.g?.value?.slice(0, 10),
      excluded: exclusionReason(name, instanceOf, description),
    };
  } catch {
    return { instanceOf: [] }; // Wikidata is a secondary check; its absence never blocks a plan
  }
}
