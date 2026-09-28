# ops

Uptime checks and the status page of CandleStack: https://ops.candlestack.tech
(team only, sign in with GitHub).

It runs on Cloudflare, not on the CandleStack server, so it keeps working when the server
is down and records how long the outage lasted.

```
Cloudflare cron, every minute ──► app.candlestack.tech/api/health        prod, public, as users see it
          (this Worker)       ──► stage.candlestack.tech/api/health      stage, through Access
                              ──► vm.candlestack.tech/api/snapshot       server agent, through Access
                                        │
                                        ▼
                                  D1 (35 days) ──► ops.candlestack.tech  page and /api/status, through Access
```

## What it shows

| Section | Source |
| --- | --- |
| Production, Staging | a health check from outside every minute; uptime and a strip of the last 30 days, one bar per day with its outages on hover (tap on a phone) |
| PR previews | the agent checks each `pr-<N>` environment on the server's internal network |
| Server | CPU, memory and disk from the agent, with 24-hour charts |
| Containers | the agent, through a read-only Docker API proxy |
| Events | automatic, nobody writes them: see below |

When the agent does not answer, the server counts as down, and the page shows the last data
it had and since when the server has been silent.

**Outage**: two or more failed checks in a row (timeout after 10 s, an HTTP status other than 200,
or a body without `"status": "ok"`). It starts at the first failed check and ends at the next good
one. A single failed check is not an outage. Uptime is the share of checked minutes outside
outages. Days and times on the page are Bratislava time.

**Events**, all derived from the checks and the agent:

| Event | When |
| --- | --- |
| *Staging stopped responding (HTTP 502)*, *… recovered after 14 min* | an outage starts and ends; the same for the server agent |
| *Staging deployed main · 1837bac* | a new main container with a new version |
| *Staging redeployed main · 1837bac* | a new main container with the same version |
| *Staging restarted* | the main container started again (a crash or a manual restart) |
| *Server rebooted* | the server's boot time moved forward |
| *Preview pr-12 started*, *… removed* | a `pr-<N>` environment appears or goes |

The main container of an environment is the compose service `backend`; the frontend and Redis
containers cause no events. Prod runs `backend` too since v0.2.0; `app` is the placeholder it ran
before, and the Worker still falls back to it for an environment without `backend`.

## Agent contract

The agent is `infra/agent/agent.py` in
[CandleStack-FEI-STU/candlestack](https://github.com/CandleStack-FEI-STU/candlestack). It stores
nothing and holds no secrets. `GET https://vm.candlestack.tech/api/snapshot` returns:

```json
{
  "schema": 1,
  "sampled_at": 1790266811,
  "host": { "label": "AWS t3.small · eu-north-1", "cpus": 2, "uptime": 71018.7, "cpu": 3.8, "load": 0.25,
            "mem_used": 715157504, "mem_total": 2004209664, "disk_used": 4237748736, "disk_total": 25821052928 },
  "containers": [{ "name": "backend", "env": "prod", "state": "running", "up": "3 hours", "cpu": 0.1, "mem": 13697664,
                   "created": 1790258400, "started": 1790258400, "version": "v0.4.0" }],
  "previews": [{ "env": "pr-5", "ok": true, "ms": 2, "version": "pr-5-<commit sha>" }]
}
```

`cpu` is `null` until the agent has two samples. `created`, `started` (unix seconds) and `version`
(the `candlestack.version` label) of the main container feed the deploy, redeploy and restart
events; an agent without them still works, without those events. A response that does not match
(`src/snapshot.ts`) or a sample older than three minutes counts as a failed check.
A change to the format needs a new `schema` number and a change in both repositories;
`test/fixtures/agent-snapshot.json` is a real response and pins the contract in the tests.

## Access

`ops.candlestack.tech` is covered by the Cloudflare Access application `team-only`
(`*.candlestack.tech`). The Worker also verifies the Access JWT on every request (`src/access.ts`),
so it stays closed even if Access were ever misconfigured; `workers.dev` and preview URLs are off.

The checks reach stage and the agent with the Access service token `ops-monitor`
(policy `ops-monitor` on `team-only`, expires 2027-09-24).

## Cost

Everything runs on the Workers Free plan. When a daily limit is reached, requests and D1
queries fail until 00:00 UTC; nothing is ever billed, and nothing here can turn on a paid plan.

| Limit (free) | Used |
| --- | --- |
| Workers: 100,000 requests a day | about 1,440 cron runs plus 2,880 a day per open page |
| D1: 100,000 rows written a day | about 13,000 (one row per target per minute, aggregates instead of raw samples) |
| D1: 5,000,000 rows read a day | about 150 per page refresh |
| Cron triggers: 5 per account | 1 |

## Development

```sh
npm ci
npm test          # Vitest inside the Workers runtime, with a local D1
npm run check     # generated types are current, TypeScript
npm run lint      # oxlint, Prettier and knip; npm run format fixes the formatting
```

To run it locally, put `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` in `.dev.vars` (any values;
git ignores the file), then:

```sh
npx wrangler d1 migrations apply DB --local   # once: the tables in the local D1
npm run dev                                   # wrangler dev on http://localhost:8787
curl 'http://localhost:8787/__scheduled'      # run the checks once, like the cron
```

With made-up values only the prod check passes: stage and the agent need the real service token.
The page answers 403 locally, as no Access JWT comes with the request.

After changing `wrangler.jsonc`, run `npm run types` and commit `worker-configuration.d.ts`.
Schema changes are new files in `migrations/`; the deploy applies them before the new code.

## Deployment

Every push to `main` deploys (`.github/workflows/deploy.yml`, environment `production`):
tests, D1 migrations, `wrangler deploy`, then a wait until `/api/health` reports that the
checks run.

Editor cannot create a Worker, only deploy an existing one: to recreate `candlestack-ops` from
scratch, give the token Workers Admin for that one deploy. Cron triggers need the account's
`workers.dev` subdomain to exist (it does; this Worker does not use it).

| Secret (environment `production`) | What |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | account API token `github-actions-ops`, expires 2027-09-25: Workers Editor, D1 Edit, Account Settings Read; Zone Read and Workers Routes Edit on candlestack.tech only |
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` | service token `ops-monitor`, sent to the Worker as secrets on every deploy |
