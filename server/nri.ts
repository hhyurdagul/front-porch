import { HAZARDS, type County, type HazardId } from "../shared/types.js";
import { ensure } from "./security.js";

// FEMA National Risk Index, county layer (December 2025 release), public ArcGIS feature service.
// Item 39485e8035d446a5bff03259508ae355 on fema.maps.arcgis.com.
export const NRI_URL =
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Counties/FeatureServer/0/query";

export async function countiesByRisk(
  state: string,
  hazard: HazardId,
  topN = 4,
  fetchImpl: typeof fetch = fetch,
): Promise<County[]> {
  ensure(/^[A-Z]{2}$/.test(state), "STATE", "Unknown state.");
  const p = HAZARDS[hazard].prefix;
  const params = new URLSearchParams({
    where: `STATEABBRV='${state}'`,
    outFields: `STCOFIPS,COUNTY,COUNTYTYPE,POPULATION,${p}_RISKS,${p}_RISKR`,
    orderByFields: `${p}_RISKS DESC`,
    returnGeometry: "true",
    outSR: "4326",
    maxAllowableOffset: "0.01",
    geometryPrecision: "3",
    f: "geojson",
  });
  const r = await fetchImpl(`${NRI_URL}?${params}`, {
    signal: AbortSignal.timeout(20000),
  });
  ensure(
    r.ok,
    "NRI_FAILURE",
    `FEMA National Risk Index request failed (${r.status}).`,
    502,
  );
  const body = (await r.json()) as {
    features?: {
      properties: Record<string, unknown>;
      geometry: County["geometry"] | null;
    }[];
  };
  const feats = (body.features ?? []).filter((f) => f.geometry);
  ensure(
    feats.length > 0,
    "NRI_EMPTY",
    "No FEMA risk data for that state.",
    502,
  );
  const counties = feats.map((f) => ({
    fips: String(f.properties.STCOFIPS),
    name: String(f.properties.COUNTY),
    kind: String(f.properties.COUNTYTYPE ?? "County"),
    population: Number(f.properties.POPULATION) || 0,
    risk: Number(f.properties[`${p}_RISKS`]) || 0,
    rating: String(f.properties[`${p}_RISKR`] ?? ""),
    top: false,
    geometry: f.geometry!,
  }));
  counties.sort((a, b) => b.risk - a.risk);
  counties.slice(0, topN).forEach((c) => (c.top = true));
  return counties;
}
