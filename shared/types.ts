// Shared between server and UI. Every number shown to a judge comes from one of these records.

export const HAZARDS = {
  tornado: { prefix: "TRND", label: "Tornado" },
  hurricane: { prefix: "HRCN", label: "Hurricane" },
  heat: { prefix: "HWAV", label: "Heat wave" },
  wildfire: { prefix: "WFIR", label: "Wildfire" },
  flood: { prefix: "RFLD", label: "Riverine flooding" },
  winter: { prefix: "WNTW", label: "Winter weather" },
} as const;
export type HazardId = keyof typeof HAZARDS;

export interface County {
  fips: string;
  name: string;
  kind: string; // County, Parish, Borough, City
  population: number;
  risk: number; // FEMA NRI hazard risk score, 0-100 (national percentile)
  rating: string;
  top: boolean; // one of the highest-risk counties chosen for this plan
  geometry: GeoJSONGeometry;
}
export type GeoJSONGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface Cell {
  geohash: string;
  lat: number;
  lon: number;
  bounds: [[number, number], [number, number]];
  affinityRank: number;
  popularity: number;
  county?: string; // county FIPS when the cell centre falls inside the state
  state?: string; // nearest-city state for US-wide cells
}

export type PartnerKind =
  | "team"
  | "university"
  | "business"
  | "media"
  | "nonprofit"
  | "artist"
  | "person"
  | "other";

export interface WikidataCheck {
  qid?: string;
  description?: string;
  instanceOf: string[];
  place?: string; // headquarters / home venue / origin / birthplace label
  inState?: boolean; // that place is located in the target state
  died?: string; // ISO date of death, people only
  defunct?: string; // ISO date an organisation was dissolved/abolished (P576)
  excluded?: string; // reason when religious or political
}

export interface Partner {
  id: string; // Qloo entity id
  name: string;
  qlooType: string;
  kind: PartnerKind;
  foundIn: string[]; // county names whose Qloo recommendations surfaced it
  homeShare: number; // share of US-wide affinity cells in the target state (Qloo locality test)
  homeStates: [string, number][];
  footprint: number; // affinity-weighted share of in-state cells inside top-risk counties
  riskWeighted: number; // affinity-weighted mean NRI hazard score over in-state cells
  coveredCounties: string[];
  cells: Cell[]; // in-state cells, for the map
  wikidata: WikidataCheck;
  local: boolean;
  score: number;
  status: "recommended" | "statewide" | "not-local" | "excluded" | "unverified";
  why: string;
}

export interface Venue {
  id: string; // Qloo entity id
  name: string;
  county: string; // the high-risk county it was found in (verified from Qloo geocode)
  address: string;
  description?: string;
}

export interface BaselineRow {
  name: string;
  claimedKind: string;
  qlooId?: string;
  qlooName?: string;
  homeShare?: number;
  homeStates?: [string, number][];
  wikidata: WikidataCheck;
  verdict:
    | "local"
    | "wikidata-local"
    | "not-local"
    | "mixed"
    | "deceased"
    | "defunct"
    | "not-found"
    | "excluded";
  note: string;
}

export interface Scorecard {
  total: number;
  verifiedLocal: number;
  notLocal: number;
  deceased: number;
  notFound: number;
  defunct: number;
  wikidataOnlyLocal: number; // not mapped by Qloo, but Wikidata places it in the state
  excluded: number;
  mixed: number; // Qloo and Wikidata disagree about locality
  wikidataInState: number; // independent of Qloo: Wikidata places the partner in the state
}

export interface TraceEntry {
  id: string;
  source: "QLOO" | "FEMA_NRI" | "WIKIDATA" | "GEMINI";
  tool: string;
  input: unknown;
  status: string;
  summary: string;
  ms: number;
  at: string;
}

export interface Invitation {
  partnerId: string;
  subject: string;
  body: string; // drafted by Gemini; contains the locked official message verbatim
}

export interface Plan {
  id: string;
  state: string;
  stateName: string;
  hazard: HazardId;
  createdAt: string;
  model: string;
  counties: County[];
  partners: Partner[];
  venues: Venue[];
  baseline: BaselineRow[];
  /** Why the model-alone baseline is empty, when it is. */
  baselineError?: string;
  scorecard: { qloo: Scorecard; gemini: Scorecard };
  officialMessage: { text: string; source: string };
  invitations: Invitation[];
  summary: string;
  trace: TraceEntry[];
  warnings: string[];
}

export type ProgressEvent =
  | { type: "progress"; step: string; detail?: string }
  | { type: "result"; plan: Plan }
  | { type: "error"; code: string; message: string };
