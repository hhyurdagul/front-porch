# How Front Porch uses Qloo

Front Porch talks to Qloo through Qloo's official MCP server, `@qloo/qloo-harness` (pinned in `tooling/`), over stdio. The full tool inventory with input and output schemas, as discovered from that server, is in [qloo-tools.discovered.json](qloo-tools.discovered.json).

## Tools called

| Tool | Arguments (shape) | Question it answers |
|---|---|---|
| `qloo_recommend` | `target_type: brand` / `artist`, `signal_location: "<County>, <State>"` | Which organisations and artists over-index around this high-risk county? |
| `qloo_recommend` | `target_type: place`, `signal_location` and `filter_location: "<County>, <State>"` | Which real venues inside this county fit its taste? (The county is confirmed from Qloo's geocode.) |
| `qloo_where_popular` | `entity`, `within: "United States"`, `limit: 20` | Is the following local? A partner is local if at least 10 of its 20 strongest US areas are in the state. |
| `qloo_where_popular` | `entity`, `within: "<State>"` | How much of the in-state following falls inside the highest-risk counties? (Areas are matched to counties by point-in-polygon on FEMA's county shapes.) |
| `qloo_describe` | `entity: "<name Gemini gave>"` | Which Qloo entity, if any, is the name a model suggested? Only exact or near-exact name matches are accepted. |
| `qloo_capabilities` | `{}` | Readiness check at startup. |

Only these four tools are allowed (`server/qloo.ts`, `ALLOWED`); any other call is refused before it reaches the server.

## Safety and limits in the client

- Every call's input and output is validated with Ajv against the schemas the server publishes.
- Calls are paced (bounded concurrency, spaced starts) so one plan does not burst the key's rate limit; errors flagged `retryable` are retried with backoff, others fail visibly.
- 15-second timeout per call; the harness's stderr is never logged; `QLOO_HOME` is a dedicated directory, never the user's home.
- Every call is recorded in the plan's evidence trail (shown in the app and in the JSON export) with its input, status, summary and timing.
- Responses are cached for 7 days and keep their original fetch time, which the app shows.

## What we found about the hackathon endpoint
- `qloo_where_popular` returns geohash cells with an affinity rank; that rank is compared only within one call, never across calls.
- Local TV and radio stations are often missing or have no map; Front Porch shows these as "couldn't check", never as wrong.
- `qloo_trends` returned no data on the hackathon endpoint, so nothing here depends on it.
