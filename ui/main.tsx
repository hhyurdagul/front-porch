import {
  StrictMode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import {
  HAZARDS,
  type BaselineRow,
  type County,
  type HazardId,
  type Invitation,
  type Partner,
  type Plan,
  type ProgressEvent,
} from "../shared/types.js";

interface Options {
  states: [string, string][];
  hazards: { id: HazardId; label: string }[];
  presets: { state: string; hazard: HazardId; label: string; ready: boolean }[];
}
const STEPS: [string, string][] = [
  ["risk", "Finding the highest-risk counties (FEMA)"],
  ["candidates", "Finding who has fans there (Qloo)"],
  ["locality", "Checking each one is local to the state (Qloo)"],
  [
    "footprint",
    "Measuring how much of the following is in the risk counties (Qloo)",
  ],
  ["wikidata", "Checking each one is real and still around (Wikidata)"],
  ["baseline", "Asking Gemini alone, and checking its answers the same way"],
  ["invite", "Drafting invitations"],
];
const KIND: Record<string, string> = {
  team: "Sports team",
  university: "University",
  business: "Local business",
  media: "Local media",
  nonprofit: "Nonprofit",
  artist: "Artist",
  person: "Public figure",
  other: "Organisation",
};
const isFigure = (p: Partner) => p.kind === "artist" || p.kind === "person";
const countyName = (c: County) => `${c.name} ${c.kind}`;
const HAZARD_PLURAL: Record<HazardId, string> = {
  tornado: "tornadoes",
  hurricane: "hurricanes",
  heat: "heat waves",
  wildfire: "wildfires",
  flood: "flooding",
  winter: "winter storms",
};
const hazardWord = (h: HazardId) => HAZARDS[h].label.toLowerCase();

function App() {
  const [opts, setOpts] = useState<Options>();
  const [state, setState] = useState("AL");
  const [hazard, setHazard] = useState<HazardId>("hurricane");
  const [plan, setPlan] = useState<Plan>();
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<{ step: string; detail?: string }[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    fetch("/api/options")
      .then((r) => r.json())
      .then(setOpts)
      .catch(() => setError("The server is not reachable."));
    const q = new URLSearchParams(location.search);
    const s = q.get("state")?.toUpperCase();
    const h = q.get("hazard") as HazardId | null;
    if (s && h) void run(s, h);
  }, []);

  async function run(s = state, h = hazard, refresh = false) {
    setState(s);
    setHazard(h);
    history.replaceState(null, "", `?state=${s}&hazard=${h}`);
    setRunning(true);
    setError(undefined);
    setLog([]);
    setPlan(undefined);
    try {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: s, hazard: h, refresh }),
      });
      if (!res.ok || !res.body) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const e = JSON.parse(line) as ProgressEvent;
          if (e.type === "progress")
            setLog((l) => [...l, { step: e.step, detail: e.detail }]);
          else if (e.type === "result") setPlan(e.plan);
          else setError(e.message);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <header className="top">
        <div className="wrap">
          <div className="brand">
            <span className="mark" aria-hidden>
              ⌂
            </span>
            <div>
              <h1>Front Porch</h1>
              <p>
                Who should help spread preparedness messages in your
                highest-risk counties?
              </p>
            </div>
          </div>
          <ol className="how">
            <li>
              <b>FEMA</b> finds the counties most at risk
            </li>
            <li>
              <b>Qloo</b> finds the local organisations whose fans live there
            </li>
            <li>
              <b>Wikidata</b> checks each one is real, local and still around
            </li>
          </ol>
        </div>
      </header>
      <main className="wrap">
        <section className="card picker">
          <p className="who">
            For county emergency managers and National Weather Service staff
            recruiting outreach partners <b>before the season</b>, as in NOAA
            {"'"}s{" "}
            <a
              href="https://www.weather.gov/wrn/ambassadors"
              target="_blank"
              rel="noreferrer"
            >
              Weather-Ready Nation Ambassadors
            </a>
            . Not for warnings during an event: those go through official alert
            channels.
          </p>
          <div className="controls">
            <label>
              State
              <select
                value={state}
                onChange={(e) => setState(e.target.value)}
                disabled={running}
              >
                {opts?.states.map(([c, n]) => (
                  <option key={c} value={c}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Hazard
              <select
                value={hazard}
                onChange={(e) => setHazard(e.target.value as HazardId)}
                disabled={running}
              >
                {opts?.hazards.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary"
              onClick={() => run()}
              disabled={running || !opts}
            >
              {running ? "Working…" : "Find partners"}
            </button>
          </div>
          {!!opts?.presets.length && (
            <div className="presets">
              <span>Examples:</span>
              {opts.presets.map((p) => (
                <button
                  key={p.label}
                  className="chip"
                  disabled={running}
                  onClick={() => run(p.state, p.hazard)}
                >
                  {p.label}
                  {p.ready && <i title="Ready instantly"> ⚡</i>}
                </button>
              ))}
            </div>
          )}
        </section>
        {error && (
          <div className="card error" role="alert">
            {error}
          </div>
        )}
        {(running || (log.length > 0 && !plan)) && <ProgressPanel log={log} />}
        {plan && (
          <PlanView
            key={plan.id}
            plan={plan}
            onRefresh={() => run(plan.state, plan.hazard, true)}
          />
        )}
      </main>
      <footer className="wrap foot">
        <p>
          Qloo shows where a following is concentrated; it is not a head count,
          a measure of trust, or proof that a message changes behaviour. A
          person approves every invitation; the official safety text is inserted
          unchanged. Data: FEMA National Risk Index (public), Qloo (hackathon
          API via the official harness), Wikidata (CC0), GeoNames (CC BY 4.0),
          map © OpenStreetMap contributors. Prototype for the Qloo Agentic
          Hackathon; not an official NOAA, NWS or FEMA product.
        </p>
      </footer>
    </>
  );
}

function ProgressPanel({ log }: { log: { step: string; detail?: string }[] }) {
  const reached = new Set(log.map((l) => l.step));
  const last = log.at(-1);
  return (
    <section className="card progress" aria-live="polite">
      <h2>Working on it (about a minute for a new state)</h2>
      <ol className="steps">
        {STEPS.map(([id, label]) => (
          <li
            key={id}
            className={
              last?.step === id ? "now" : reached.has(id) ? "done" : ""
            }
          >
            {label}
          </li>
        ))}
      </ol>
      {last?.detail && <p className="ticker">{last.detail}</p>}
    </section>
  );
}

/** Groups Gemini's answers the way a reader thinks about them. */
function geminiGroups(rows: BaselineRow[]) {
  const by = (vs: BaselineRow["verdict"][]) =>
    rows.filter((r) => vs.includes(r.verdict));
  return {
    good: by(["local", "wikidata-local"]),
    wrong: by(["not-local", "deceased", "defunct"]),
    unsure: by(["mixed", "not-found", "excluded"]),
  };
}

function PlanView({ plan, onRefresh }: { plan: Plan; onRefresh: () => void }) {
  const rec = plan.partners.filter((p) => p.status === "recommended");
  const orgs = rec.filter((p) => !isFigure(p));
  const figures = rec.filter(isFigure);
  const statewide = plan.partners.filter((p) => p.status === "statewide");
  const rejected = plan.partners.filter(
    (p) => p.status === "not-local" || p.status === "excluded",
  );
  const [selected, setSelected] = useState((orgs[0] ?? rec[0])?.id);
  const sel = plan.partners.find((p) => p.id === selected);
  const top = plan.counties.filter((c) => c.top);
  const g = geminiGroups(plan.baseline);
  const lead = orgs[0];
  const hz = hazardWord(plan.hazard);
  const invite = (p: Partner) =>
    plan.invitations.find((i) => i.partnerId === p.id);
  const card = (p: Partner, rank?: number) => (
    <PartnerCard
      key={p.id}
      p={p}
      plan={plan}
      rank={rank}
      active={p.id === selected}
      onSelect={setSelected}
      invitation={invite(p)}
      openInvite={rank === 1}
    />
  );

  return (
    <>
      <section className="card answer">
        <p className="eyebrow">
          {plan.stateName} · {HAZARDS[plan.hazard].label}
        </p>
        <h2>
          {lead ? (
            <>
              Invite <span className="hl">{lead.name}</span>
              {orgs.length > 1 && ` and ${orgs.length - 1} more`}.{" "}
              <span className="sub">
                {Math.round(lead.footprint * 100)}% of its {plan.stateName}{" "}
                following lives in the {top.length} counties most at risk from{" "}
                {HAZARD_PLURAL[plan.hazard]}.
              </span>
            </>
          ) : (
            <>
              No organisation{"'"}s following is concentrated in the{" "}
              {top.length} highest-risk counties.{" "}
              <span className="sub">Other options are listed below.</span>
            </>
          )}
        </h2>
        <nav className="stats">
          <a href="#invite" className="stat">
            <b>{orgs.length}</b>
            <span>organisation{orgs.length === 1 ? "" : "s"} to invite</span>
          </a>
          <a href="#invite" className="stat">
            <b>{figures.length}</b>
            <span>
              public figure{figures.length === 1 ? "" : "s"} to vet first
            </span>
          </a>
          <a href="#venues" className="stat">
            <b>{plan.venues.length}</b>
            <span>local places for events and posters</span>
          </a>
          <a href="#gemini" className="stat">
            <b>
              {plan.baseline.length
                ? `${g.good.length} of ${plan.baseline.length}`
                : "–"}
            </b>
            <span>Gemini-alone answers that checked out</span>
          </a>
        </nav>
      </section>

      <Section n={1} id="risk" title="Where the risk is">
        <p className="lede">
          FEMA{"'"}s National Risk Index rates these as {plan.stateName}
          {"'"}s highest {hz}-risk counties. The score is a national percentile:
          99 means riskier than 99% of US counties.
        </p>
        <div className="counties">
          {top.map((c) => (
            <div key={c.fips} className="county">
              <span className="cname">{countyName(c)}</span>
              <span className="bar">
                <i style={{ width: `${c.risk}%` }} />
              </span>
              <b>{c.risk.toFixed(1)}</b>
              <small>{c.population.toLocaleString("en-US")} people</small>
            </div>
          ))}
        </div>
      </Section>

      <Section n={2} id="invite" title="Who to invite">
        <p className="lede">
          Organisations whose following is concentrated in those counties. Pick
          one to see on the map where its fans are.
        </p>
        <div className="split">
          <div className="plist">
            <h3 className="group">Invite</h3>
            {orgs.length === 0 && (
              <p className="muted">
                None found for these counties. See the groups below.
              </p>
            )}
            {orgs.map((p, i) => card(p, i + 1))}
            {figures.length > 0 && (
              <>
                <h3 className="group">Vet before inviting</h3>
                <p className="muted small">
                  Their fans live in the risk counties too, but Qloo cannot tell
                  whether a public figure suits an official safety message. No
                  invitation is drafted; check their record first.
                </p>
                {figures.map((p) => card(p))}
              </>
            )}
            {statewide.length > 0 && (
              <details className="more">
                <summary>
                  Local to {plan.stateName}, but their fans mostly live
                  elsewhere in the state ({statewide.length})
                </summary>
                {statewide.map((p) => card(p))}
              </details>
            )}
            {rejected.length > 0 && (
              <details className="more">
                <summary>Ruled out ({rejected.length})</summary>
                <ul className="rejects">
                  {rejected.map((p) => (
                    <li key={p.id}>
                      <b>{p.name}</b>: {p.why}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <div className="mapcol">
            <div className="mapbox">
              <p className="maptitle">
                {sel ? (
                  <>
                    Where <b>{sel.name}</b>
                    {"'"}s fans are
                  </>
                ) : (
                  "County risk"
                )}
              </p>
              <RiskMap counties={plan.counties} partner={sel} />
              <p className="legend">
                <span>
                  <span className="sw sw-top" /> highest-risk county
                </span>
                <span>
                  <span className="sw sw-risk" /> county risk (darker = higher)
                </span>
                <span>
                  <span className="sw sw-cell" /> where the following is
                  strongest (Qloo)
                </span>
              </p>
            </div>
          </div>
        </div>
      </Section>

      {plan.venues.length > 0 && (
        <Section
          n={3}
          id="venues"
          title="Where to hold events or put up posters"
        >
          <p className="lede">
            Real places inside each risk county that match local taste,
            according to Qloo.
          </p>
          <div className="vgrid">
            {top.map((c) => {
              const vs = plan.venues.filter((v) => v.county === c.name);
              if (!vs.length) return null;
              return (
                <div key={c.fips}>
                  <h3>{countyName(c)}</h3>
                  <ul>
                    {vs.slice(0, 8).map((v) => (
                      <li key={v.id}>
                        <b>{v.name}</b>
                        <small>{v.address}</small>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section
        n={plan.venues.length ? 4 : 3}
        id="gemini"
        title="Why not just ask a chatbot?"
      >
        <Gemini plan={plan} />
      </Section>

      <Section n={plan.venues.length ? 5 : 4} id="evidence" title="Evidence">
        <p className="lede">
          Built {plan.createdAt.slice(0, 16).replace("T", " ")} UTC from{" "}
          {plan.trace.length} requests to FEMA, Qloo, Wikidata and Gemini.
        </p>
        <div className="actions">
          <a className="btn" href={`/api/plans/${plan.id}?format=html`}>
            Download outreach brief (HTML)
          </a>
          <a className="btn" href={`/api/plans/${plan.id}?format=json`}>
            Download all evidence (JSON)
          </a>
          <button className="btn" onClick={onRefresh}>
            Rebuild live
          </button>
        </div>
        <details className="more trace">
          <summary>Every request, in order ({plan.trace.length})</summary>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Call</th>
                  <th>Input</th>
                  <th>Result</th>
                  <th>ms</th>
                </tr>
              </thead>
              <tbody>
                {plan.trace.map((t) => (
                  <tr key={t.id}>
                    <td>{t.source}</td>
                    <td>{t.tool}</td>
                    <td>
                      <code>{JSON.stringify(t.input)}</code>
                    </td>
                    <td>
                      {t.status}: {t.summary}
                    </td>
                    <td>{t.ms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        {plan.warnings.length > 0 && (
          <div className="warn">
            {plan.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function Section({
  n,
  id,
  title,
  children,
}: {
  n: number;
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="card step" id={id}>
      <h2>
        <span className="num">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function PartnerCard({
  p,
  plan,
  rank,
  active,
  onSelect,
  invitation,
  openInvite,
}: {
  p: Partner;
  plan: Plan;
  rank?: number;
  active: boolean;
  onSelect: (id: string) => void;
  invitation?: Invitation;
  openInvite?: boolean;
}) {
  const inState =
    p.homeStates.find(([s]) => s === plan.state)?.[1] ??
    Math.round(p.homeShare * 20);
  const counties = p.coveredCounties.join(", ");
  return (
    <article className={`partner ${active ? "active" : ""}`}>
      <button
        className="pmain"
        onClick={() => onSelect(p.id)}
        aria-pressed={active}
      >
        <div className="phead">
          {rank && <span className="rank">{rank}</span>}
          <span className="pname">
            <b>{p.name}</b>
            <small>
              {KIND[p.kind]}
              {p.wikidata.place && ` · based in ${p.wikidata.place}`}
            </small>
          </span>
          <span className="big">
            {Math.round(p.footprint * 100)}%
            <small>
              of its {plan.stateName} fans live in the risk counties
            </small>
          </span>
        </div>
        <ul className="facts">
          {counties && <li>Strongest in {counties}</li>}
          <li>
            {inState} of its 20 strongest US areas are in {plan.stateName}{" "}
            <span className="src">Qloo</span>
          </li>
          {p.wikidata.inState && (
            <li>
              Based in {plan.stateName} <span className="src">Wikidata</span>
            </li>
          )}
        </ul>
        <span className="maplink">
          {active ? "Shown on the map" : "Show on the map"}
        </span>
      </button>
      {invitation && (
        <InviteDraft
          inv={invitation}
          official={plan.officialMessage.text}
          open={openInvite}
        />
      )}
    </article>
  );
}

function InviteDraft({
  inv,
  official,
  open,
}: {
  inv: Invitation;
  official: string;
  open?: boolean;
}) {
  const [ok, setOk] = useState(false);
  const i = inv.body.indexOf(official);
  return (
    <details className="invite" open={open}>
      <summary>Invitation draft (needs your review)</summary>
      <p className="subject">
        <b>Subject:</b> {inv.subject}
      </p>
      <pre>
        {i >= 0 ? (
          <>
            {inv.body.slice(0, i)}
            <mark title="Official National Weather Service message, inserted unchanged">
              {official}
            </mark>
            {inv.body.slice(i + official.length)}
          </>
        ) : (
          inv.body
        )}
      </pre>
      <p className="small muted">
        Gemini wrote the greeting and closing. The highlighted safety message is
        the official National Weather Service text, inserted word for word.
      </p>
      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={ok}
            onChange={(e) => setOk(e.target.checked)}
          />{" "}
          I have reviewed this
        </label>
        <button
          className="btn"
          disabled={!ok}
          onClick={() =>
            navigator.clipboard?.writeText(`${inv.subject}\n\n${inv.body}`)
          }
        >
          Copy
        </button>
      </div>
    </details>
  );
}

/** A one-line, plain-language reason for each Gemini answer; the raw evidence sits underneath. */
function plainReason(b: BaselineRow, stateName: string) {
  const w = b.wikidata;
  switch (b.verdict) {
    case "local":
      return `Local: its fans are concentrated in ${stateName}${w.inState ? ` and it is based in ${w.place}` : ""}.`;
    case "wikidata-local":
      return `Based in ${w.place}, ${stateName}; Qloo has no map of its fans.`;
    case "defunct":
      return `No longer exists: dissolved ${w.defunct?.slice(0, 4)}.`;
    case "deceased":
      return `Died ${w.died?.slice(0, 10)}.`;
    case "not-local": {
      const [st, n] = b.homeStates?.[0] ?? [];
      return st
        ? `Not local: its fans are mostly in ${st} (${n} of its 20 strongest US areas), and Wikidata places it in ${w.place}.`
        : `Not local: Wikidata places it in ${w.place}, outside ${stateName}.`;
    }
    case "mixed":
      return `Sources disagree: Wikidata places it in ${stateName}, but Qloo maps its fans elsewhere.`;
    case "excluded":
      return "Religious or political organisation: not used for official messages.";
    default: {
      const closest = /closest: (.+)\)$/.exec(b.note)?.[1];
      // Only mention Qloo's nearest name when it plausibly is the same thing (starts with the same word).
      const first = b.name.toLowerCase().split(/[^a-z0-9]+/)[0];
      if (closest)
        return closest.toLowerCase().startsWith(first)
          ? `No exact match in Qloo (nearest: ${closest}).`
          : "Not in Qloo under this name.";
      if (/without a US map|no map/.test(b.note))
        return "In Qloo, but Qloo has no map of where its fans are.";
      if (/no location to confirm/.test(b.note))
        return "Qloo maps its fans to other states, but no second source confirms it.";
      return "Not found in Qloo or Wikidata.";
    }
  }
}

function Gemini({ plan }: { plan: Plan }) {
  const g = geminiGroups(plan.baseline);
  if (!plan.baseline.length)
    return (
      <p className="warn">
        {plan.model} gave no list for this plan
        {plan.baselineError ? ` (${plan.baselineError})` : ""}, so there is
        nothing to compare. Use “Rebuild live” below to ask again.
      </p>
    );
  const group = (title: string, cls: string, rows: BaselineRow[]) =>
    rows.length > 0 && (
      <div className={`ggroup ${cls}`}>
        <h3>
          {title} <span>{rows.length}</span>
        </h3>
        <ul>
          {rows.map((b) => (
            <li key={b.name}>
              <b>{b.name}</b>
              <span>{plainReason(b, plan.stateName)}</span>
              {cls !== "unsure" && <small>{b.note}</small>}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <>
      <p className="lede">
        We asked Gemini ({plan.model}) the same question with no data: “list 10
        local partners whose audiences are concentrated in these counties”. Then
        we checked every answer with the same Qloo and Wikidata tests.
      </p>
      <div className="ggrid">
        {group("Checked out", "good", g.good)}
        {group("Wrong", "bad", g.wrong)}
        {group("Couldn't check", "unsure", g.unsure)}
      </div>
      <p className="takeaway">
        Gemini alone usually names a few genuinely local institutions. What it
        cannot tell you is where each partner{"'"}s fans live compared with the
        risk, and it cannot find local venues. That is what Qloo adds.
      </p>
    </>
  );
}

function RiskMap({
  counties,
  partner,
}: {
  counties: County[];
  partner?: Partner;
}) {
  const el = useRef<HTMLDivElement>(null);
  const cells = useRef<L.LayerGroup | undefined>(undefined);
  const map = useRef<L.Map | undefined>(undefined);
  const topBounds = useRef<L.LatLngBounds | undefined>(undefined);
  const base = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: counties.map((c) => ({
        type: "Feature" as const,
        properties: { name: c.name, kind: c.kind, risk: c.risk, top: c.top },
        geometry: c.geometry,
      })),
    }),
    [counties],
  );
  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, {
      scrollWheelZoom: false,
      attributionControl: true,
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      // The page sends no Referer; OSM's tile policy requires one, so tiles send the origin only.
      referrerPolicy: "strict-origin",
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 12,
      className: "basemap",
    }).addTo(m);
    const layer = L.geoJSON(base as GeoJSON.FeatureCollection, {
      style: (f) => ({
        color: f?.properties.top ? "#b42318" : "#8a94a6",
        weight: f?.properties.top ? 3 : 0.6,
        fillColor: riskColor(f?.properties.risk ?? 0),
        fillOpacity: 0.5,
      }),
      onEachFeature: (f, l) =>
        l.bindTooltip(
          `${f.properties.name} ${f.properties.kind}: risk ${Number(f.properties.risk).toFixed(1)}`,
        ),
    }).addTo(m);
    m.fitBounds(layer.getBounds(), { padding: [10, 10] });
    const tops = L.geoJSON({
      ...base,
      features: base.features.filter((f) => f.properties.top),
    } as GeoJSON.FeatureCollection);
    topBounds.current = tops.getBounds();
    cells.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = undefined;
    };
  }, [base]);
  useEffect(() => {
    const g = cells.current;
    if (!g) return;
    g.clearLayers();
    const view = topBounds.current ? L.latLngBounds([]) : undefined;
    if (view && partner?.cells.length) view.extend(topBounds.current!);
    for (const c of partner?.cells ?? []) {
      view?.extend(c.bounds);
      L.rectangle(c.bounds, {
        color: "#0b2a6f",
        weight: 1.5,
        fillColor: "#1570ef",
        fillOpacity: 0.45 + 0.45 * c.affinityRank,
      })
        .bindTooltip(
          `${partner!.name}: following strength ${Math.round(c.affinityRank * 100)} of 100`,
        )
        .addTo(g);
    }
    // Zoom to the risk counties and this partner's fan areas, so the overlap is visible.
    if (view?.isValid()) map.current?.fitBounds(view, { padding: [24, 24] });
  }, [partner, base]);
  return (
    <div
      ref={el}
      className="map"
      role="img"
      aria-label="Map of county risk and where the selected partner's fans are"
    />
  );
}
function riskColor(r: number) {
  const stops = [
    "#fff7ec",
    "#fee8c8",
    "#fdd49e",
    "#fdbb84",
    "#fc8d59",
    "#e34a33",
    "#b30000",
  ];
  return stops[
    Math.min(stops.length - 1, Math.floor((r / 100) * stops.length))
  ];
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
