import { readFileSync } from "node:fs";
import type { GeoJSONGeometry } from "../shared/types.js";

const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Geohash → bounding box [[south, west], [north, east]] and centre. */
export function geohashBounds(g: string) {
  const lat = [-90, 90];
  const lon = [-180, 180];
  let even = true;
  for (const ch of g) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("bad geohash");
    for (const m of [16, 8, 4, 2, 1]) {
      const r = even ? lon : lat;
      const mid = (r[0] + r[1]) / 2;
      if (v & m) r[0] = mid;
      else r[1] = mid;
      even = !even;
    }
  }
  return {
    bounds: [
      [lat[0], lon[0]],
      [lat[1], lon[1]],
    ] as [[number, number], [number, number]],
    lat: (lat[0] + lat[1]) / 2,
    lon: (lon[0] + lon[1]) / 2,
  };
}

function inRing(lon: number, lat: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}
function inPolygon(lon: number, lat: number, rings: number[][][]) {
  if (!rings.length || !inRing(lon, lat, rings[0])) return false;
  return !rings.slice(1).some((h) => inRing(lon, lat, h));
}
export function pointInGeometry(lat: number, lon: number, g: GeoJSONGeometry) {
  return g.type === "Polygon"
    ? inPolygon(lon, lat, g.coordinates)
    : g.coordinates.some((p) => inPolygon(lon, lat, p));
}

// US places with population > 15,000 (GeoNames cities15000, CC BY 4.0): [lat, lon, state].
// Used only to label the state of a US-wide Qloo affinity cell by its nearest town.
let towns: [number, number, string][] | undefined;
function loadTowns() {
  towns ??= JSON.parse(readFileSync("docs/us-towns.json", "utf8"));
  return towns!;
}
export function nearestState(lat: number, lon: number) {
  const c = Math.cos((lat * Math.PI) / 180);
  let best = "";
  let bd = Infinity;
  for (const [a, o, s] of loadTowns()) {
    const d = (a - lat) ** 2 + ((o - lon) * c) ** 2;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

export const STATES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};
