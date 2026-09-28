// GET /api/status: everything the page shows, read in one D1 batch.

import { INTERVAL, localDay, type Event, type TargetState } from "./checks";
import type { Container, HostMetrics, Snapshot } from "./snapshot";
import { isPreview, previewNumber, targetName } from "./targets";

type State = "up" | "warn" | "down" | "unknown";

export interface Day {
  /** YYYY-MM-DD, a calendar day in Bratislava. */
  date: string;
  checks: number;
  /** Minutes of outage (two or more failed checks in a row). */
  down: number;
  mark: "none" | "up" | "outage";
}

export interface Outage {
  started: number;
  /** Null while it lasts. */
  ended: number | null;
  detail: string | null;
}

export interface TargetStatus {
  env: string;
  name: string;
  host: string;
  state: State;
  ms: number | null;
  version: string | null;
  detail: string | null;
  checked_at: number | null;
  down_since: number | null;
}

export interface EnvironmentStatus extends TargetStatus {
  uptime30: number | null;
  days: Day[];
  /** Outages that touch the last 30 days, oldest first. */
  outages: Outage[];
}

export interface Status {
  now: number;
  interval: number;
  /** When the cron last ran; null before the first run. */
  last_check: number | null;
  environments: EnvironmentStatus[];
  previews: TargetStatus[];
  /** Filled once the app exposes /api/health/sources. */
  sources: null;
  server: {
    state: State;
    detail: string | null;
    down_since: number | null;
    /** When the agent last answered. */
    fetched_at: number | null;
    host: HostMetrics | null;
    cpu_24h: (number | null)[];
    mem_24h: (number | null)[];
    disk_per_day: number | null;
  };
  containers: Container[];
  events: Event[];
}

interface HourRow {
  hour: number;
  samples: number;
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
}

interface DayRow {
  target: string;
  day: number;
  checks: number;
  down: number;
}

const HOSTS: Record<string, string> = {
  prod: "app.candlestack.tech",
  stage: "stage.candlestack.tech",
};

function stateOf(row: TargetState | undefined): State {
  if (!row) return "unknown";
  if (row.ok) return "up";
  return row.fails >= 2 ? "down" : "warn";
}

function targetStatus(id: string, row: TargetState | undefined): TargetStatus {
  return {
    env: id,
    name: targetName(id),
    host: HOSTS[id] ?? `${id}-preview.candlestack.tech`,
    state: stateOf(row),
    ms: row?.ms ?? null,
    version: row?.version ?? null,
    detail: row?.detail ?? null,
    checked_at: row?.checked_at ?? null,
    down_since: row?.down_since ?? null,
  };
}

function days(rows: DayRow[], today: number): Day[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: 30 }, (_, i) => {
    const day = today - 29 + i;
    const row = byDay.get(day);
    const checks = row?.checks ?? 0;
    // An outage that started the minute before midnight counts that minute on the new day.
    const down = Math.min(row?.down ?? 0, checks);
    return {
      date: new Date(day * 86_400_000).toISOString().slice(0, 10),
      checks,
      down,
      mark: !checks ? "none" : down ? "outage" : "up",
    };
  });
}

function uptime(list: Day[]): number | null {
  const checks = list.reduce((sum, d) => sum + d.checks, 0);
  const down = list.reduce((sum, d) => sum + d.down, 0);
  // Rounded down, so any outage keeps the figure below 100.
  return checks ? Math.floor(((checks - down) / checks) * 10000) / 100 : null;
}

export async function status(db: D1Database, now: number): Promise<Status> {
  const today = localDay(now);
  const hourNow = Math.floor(now / 3600);
  const [targets, daily, hourly, snapshot, events, outages] = await db.batch([
    db.prepare("SELECT * FROM targets"),
    db
      .prepare("SELECT target, day, checks, down FROM daily WHERE target IN ('prod', 'stage') AND day > ?")
      .bind(today - 30),
    db.prepare("SELECT * FROM hourly WHERE hour >= ?").bind(hourNow - 24),
    db.prepare("SELECT fetched_at, body FROM snapshot WHERE id = 1"),
    db.prepare("SELECT ts, target, source, message FROM events ORDER BY id DESC LIMIT 15"),
    db
      .prepare("SELECT target, started, ended, detail FROM outages WHERE ended IS NULL OR ended > ? ORDER BY started")
      .bind(now - 31 * 86400),
  ]);

  const byId = new Map((targets!.results as TargetState[]).map((row) => [row.id, row]));
  const dayRows = daily!.results as DayRow[];
  const outageRows = outages!.results as (Outage & { target: string })[];
  const environments = ["prod", "stage"].map((id) => {
    const list = days(
      dayRows.filter((r) => r.target === id),
      today,
    );
    return {
      ...targetStatus(id, byId.get(id)),
      uptime30: uptime(list),
      days: list,
      outages: outageRows
        .filter((o) => o.target === id)
        .map(({ started, ended, detail }) => ({ started, ended, detail })),
    };
  });
  const previews = [...byId.keys()]
    .filter(isPreview)
    .sort((a, b) => previewNumber(a) - previewNumber(b))
    .map((id) => targetStatus(id, byId.get(id)));

  const snap = snapshot!.results[0] as { fetched_at: number; body: string } | undefined;
  const latest = snap ? (JSON.parse(snap.body) as Snapshot) : undefined;

  const hours = new Map((hourly!.results as HourRow[]).map((r) => [r.hour, r]));
  const series = (value: (r: HourRow) => number) =>
    Array.from({ length: 24 }, (_, i) => {
      const row = hours.get(hourNow - 23 + i);
      return row ? value(row) : null;
    });
  const dayAgo = hours.get(hourNow - 24);

  const vm = byId.get("vm");
  const checkedAt = [byId.get("prod")?.checked_at, byId.get("stage")?.checked_at].filter((t): t is number => t != null);

  return {
    now,
    interval: INTERVAL,
    last_check: checkedAt.length ? Math.max(...checkedAt) : null,
    environments,
    previews,
    sources: null,
    server: {
      state: stateOf(vm),
      detail: vm?.detail ?? null,
      down_since: vm?.down_since ?? null,
      fetched_at: snap?.fetched_at ?? null,
      host: latest?.host ?? null,
      cpu_24h: series((r) => r.cpu / r.samples),
      mem_24h: series((r) => (r.mem_used / r.samples / r.mem_total) * 100),
      disk_per_day: latest && dayAgo ? latest.host.disk_used - dayAgo.disk_used : null,
    },
    containers: latest?.containers ?? [],
    events: events!.results as unknown as Event[],
  };
}
