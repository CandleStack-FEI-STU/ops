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
| Production, Staging | a health check from outside every minute; uptime and a strip of the last 30 days |
| PR previews | the agent checks each `pr-<N>` environment on the server's internal network |
| Server | CPU, memory and disk from the agent, with 24-hour charts |
| Containers | the agent, through a read-only Docker API proxy |
| Events | derived from the checks: outages (two failed checks in a row), recoveries with their length, deploys (a new version), previews started and removed |

When the agent does not answer, the server counts as down, and the page shows the last data
it had and since when the server has been silent.

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
  "containers": [{ "name": "app", "env": "prod", "state": "running", "up": "3 hours", "cpu": 0.1, "mem": 13697664 }],
  "previews": [{ "env": "pr-5", "ok": true, "ms": 2, "version": "pr-5-<commit sha>" }]
}
```

`cpu` is `null` until the agent has two samples. A response that does not match
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
```

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
