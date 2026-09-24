// Runs every minute from the cron trigger. Prod and stage are checked from outside, the way
// users reach them (through Cloudflare and the tunnel). The server agent is asked for a
// snapshot of the machine; if it does not answer, the server itself counts as down.

import { parseSnapshot, type Snapshot } from "./snapshot";
import { formatDuration, isPreview, shortVersion, targetName } from "./targets";

export const INTERVAL = 60;
export const RETENTION_DAYS = 35;
const TIMEOUT_MS = 10_000;
const MAX_BODY = 256 * 1024;
/** The agent samples every minute; an older sample means its collector is stuck. */
const AGENT_STALE_S = 3 * INTERVAL;
const USER_AGENT = "candlestack-ops/2.0 (+https://github.com/CandleStack-FEI-STU/ops)";

export interface CheckResult {
  target: string;
  ok: boolean;
  ms: number | null;
  version: string | null;
  /** Why the check failed. */
  detail: string | null;
}

export interface TargetState {
  id: string;
  ok: number;
  ms: number | null;
  version: string | null;
  detail: string | null;
  checked_at: number;
  fails: number;
  down_since: number | null;
}

export interface Event {
  ts: number;
  target: string;
  source: "health check" | "deploy" | "preview";
  message: string;
}

type Fetcher = typeof fetch;

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetcher: Fetcher,
): Promise<{ ms: number | null; body?: unknown; detail?: string }> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && err.name === "TimeoutError";
    return { ms: null, detail: timeout ? "timeout" : "unreachable" };
  }
  const ms = Date.now() - started;
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { ms, detail: "Access rejected the check" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ms, detail: `HTTP ${response.status}` };
  }
  const text = await response.text();
  if (text.length > MAX_BODY) return { ms, detail: "response too large" };
  try {
    return { ms, body: JSON.parse(text) };
  } catch {
    return { ms, detail: "not JSON" };
  }
}

export async function checkHealth(
  target: string,
  url: string,
  headers: Record<string, string>,
  fetcher: Fetcher,
): Promise<CheckResult> {
  const { ms, body, detail } = await getJson(url, headers, fetcher);
  if (detail) return { target, ok: false, ms, version: null, detail };
  const health = (body ?? {}) as { status?: unknown; version?: unknown };
  const version = typeof health.version === "string" ? health.version.slice(0, 100) : null;
  const ok = health.status === "ok";
  return { target, ok, ms, version, detail: ok ? null : "unhealthy" };
}

export async function checkAgent(
  url: string,
  headers: Record<string, string>,
  now: number,
  fetcher: Fetcher,
): Promise<{ result: CheckResult; snapshot?: Snapshot }> {
  const fail = (ms: number | null, detail: string) => ({
    result: { target: "vm", ok: false, ms, version: null, detail },
  });
  const { ms, body, detail } = await getJson(url, headers, fetcher);
  if (detail) return fail(ms, detail);
  const snapshot = parseSnapshot(body);
  if (!snapshot) return fail(ms, "unexpected response");
  if (now - snapshot.sampled_at > AGENT_STALE_S) return fail(ms, "stale data");
  return { result: { target: "vm", ok: true, ms, version: null, detail: null }, snapshot };
}

/** The next state of one target and the events its new result causes. */
export function transition(
  prev: TargetState | undefined,
  result: CheckResult,
  ts: number,
): { next: TargetState; events: Event[] } {
  const name = targetName(result.target);
  const events: Event[] = [];
  const event = (source: Event["source"], message: string) =>
    events.push({ ts, target: result.target, source, message });

  const next: TargetState = {
    id: result.target,
    ok: result.ok ? 1 : 0,
    ms: result.ms,
    version: prev?.version ?? null,
    detail: result.detail,
    checked_at: ts,
    fails: prev?.fails ?? 0,
    down_since: prev?.down_since ?? null,
  };

  if (!prev && isPreview(result.target)) event("preview", `${name} started`);

  if (result.ok) {
    if (prev?.down_since != null) {
      event("health check", `${name} recovered after ${formatDuration(ts - prev.down_since)}`);
    }
    if (prev?.version && result.version && result.version !== prev.version) {
      event("deploy", `${name} deployed ${shortVersion(result.version)}`);
    }
    next.version = result.version ?? next.version;
    next.fails = 0;
    next.down_since = null;
  } else {
    next.fails += 1;
    // Two failed checks in a row, so a single dropped request is not an outage.
    if (next.fails === 2 && next.down_since == null) {
      next.down_since = ts - INTERVAL;
      event("health check", `${name} stopped responding (${result.detail ?? "failed"})`);
    }
  }
  return { next, events };
}

/** Writes one minute of results. Everything goes in a single D1 batch (one transaction). */
export async function record(
  db: D1Database,
  ts: number,
  results: CheckResult[],
  snapshot: Snapshot | undefined,
): Promise<Event[]> {
  const { results: rows } = await db.prepare("SELECT * FROM targets").all<TargetState>();
  const prev = new Map(rows.map((row) => [row.id, row]));
  const statements: D1PreparedStatement[] = [];
  const events: Event[] = [];

  const upsertTarget = db.prepare(
    `INSERT INTO targets (id, ok, ms, version, detail, checked_at, fails, down_since)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET ok = excluded.ok, ms = excluded.ms, version = excluded.version,
       detail = excluded.detail, checked_at = excluded.checked_at, fails = excluded.fails,
       down_since = excluded.down_since`,
  );
  for (const result of results) {
    const { next, events: caused } = transition(prev.get(result.target), result, ts);
    statements.push(
      upsertTarget.bind(next.id, next.ok, next.ms, next.version, next.detail, next.checked_at,
        next.fails, next.down_since),
    );
    events.push(...caused);
  }

  // Previews come from the agent, so they are only known to be gone when it answered.
  if (snapshot) {
    const running = new Set(snapshot.previews.map((p) => p.env));
    for (const id of prev.keys()) {
      if (isPreview(id) && !running.has(id)) {
        events.push({ ts, target: id, source: "preview", message: `${targetName(id)} removed` });
        statements.push(db.prepare("DELETE FROM targets WHERE id = ?").bind(id));
      }
    }
  }

  const insertEvent = db.prepare("INSERT INTO events (ts, target, source, message) VALUES (?, ?, ?, ?)");
  for (const e of events) statements.push(insertEvent.bind(e.ts, e.target, e.source, e.message));

  const countDay = db.prepare(
    `INSERT INTO daily (target, day, checks, failed) VALUES (?, ?, 1, ?)
     ON CONFLICT (target, day) DO UPDATE SET checks = checks + 1, failed = failed + excluded.failed`,
  );
  const day = Math.floor(ts / 86400);
  for (const result of results) {
    if (result.target === "prod" || result.target === "stage") {
      statements.push(countDay.bind(result.target, day, result.ok ? 0 : 1));
    }
  }

  if (snapshot) {
    statements.push(
      db
        .prepare(
          `INSERT INTO snapshot (id, fetched_at, body) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET fetched_at = excluded.fetched_at, body = excluded.body`,
        )
        .bind(ts, JSON.stringify(snapshot)),
    );
    const { host } = snapshot;
    if (host.cpu !== null) {
      statements.push(
        db
          .prepare(
            `INSERT INTO hourly (hour, samples, cpu, mem_used, mem_total, disk_used) VALUES (?, 1, ?, ?, ?, ?)
             ON CONFLICT (hour) DO UPDATE SET samples = samples + 1, cpu = cpu + excluded.cpu,
               mem_used = mem_used + excluded.mem_used, mem_total = excluded.mem_total,
               disk_used = excluded.disk_used`,
          )
          .bind(Math.floor(ts / 3600), host.cpu, host.mem_used, host.mem_total, host.disk_used),
      );
    }
  }

  // Old rows go once an hour; the tables stay a few hundred rows each.
  if (ts % 3600 === 300) {
    const cutoff = ts - RETENTION_DAYS * 86400;
    statements.push(db.prepare("DELETE FROM daily WHERE day < ?").bind(Math.floor(cutoff / 86400)));
    statements.push(db.prepare("DELETE FROM hourly WHERE hour < ?").bind(Math.floor(ts / 3600) - 48));
    statements.push(db.prepare("DELETE FROM events WHERE ts < ?").bind(cutoff));
  }

  await db.batch(statements);
  return events;
}

export async function runChecks(env: Env, scheduledTime: number, fetcher: Fetcher = fetch) {
  const ts = Math.floor(scheduledTime / 1000 / INTERVAL) * INTERVAL;
  const access = {
    "CF-Access-Client-Id": env.ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.ACCESS_CLIENT_SECRET,
  };
  const [prod, stage, agent] = await Promise.all([
    checkHealth("prod", `${env.PROD_URL}/api/health`, {}, fetcher),
    checkHealth("stage", `${env.STAGE_URL}/api/health`, access, fetcher),
    checkAgent(`${env.AGENT_URL}/api/snapshot`, access, ts, fetcher),
  ]);
  const previews: CheckResult[] = (agent.snapshot?.previews ?? []).map((p) => ({
    target: p.env,
    ok: p.ok,
    ms: p.ms,
    version: p.version,
    detail: p.ok ? null : "unhealthy",
  }));
  return record(env.DB, ts, [prod, stage, agent.result, ...previews], agent.snapshot);
}
