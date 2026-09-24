import { env } from "cloudflare:workers";
import type { Snapshot } from "../src/snapshot";

/** 2026-09-24 12:00 UTC: a whole hour, so the hourly clean-up does not run. */
export const T0 = Date.UTC(2026, 8, 24, 12, 0);
export const minute = (n: number) => T0 + n * 60_000;
export const seconds = (ms: number) => Math.floor(ms / 1000);

export async function resetDb() {
  await env.DB.batch(
    ["targets", "daily", "hourly", "snapshot", "events"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
}

export function snapshot(sampledAt: number, previews: Snapshot["previews"] = []): Snapshot {
  return {
    schema: 1,
    sampled_at: sampledAt,
    host: {
      label: "AWS t3.small · eu-north-1",
      cpus: 2,
      uptime: 86_400,
      cpu: 12.5,
      load: 0.1,
      mem_used: 1_000_000_000,
      mem_total: 2_000_000_000,
      disk_used: 5_000_000_000,
      disk_total: 25_000_000_000,
    },
    containers: [{ name: "app", env: "prod", state: "running", up: "2 hours", cpu: 0.1, mem: 12_000_000 }],
    previews,
  };
}

type Reply = Response | Error;

/** A fetch that answers from a table of URLs and records every request. */
export function fakeFetch(replies: Record<string, () => Reply>) {
  const requests: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const reply = replies[request.url]?.() ?? new TypeError("unreachable");
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  return { fetcher, requests };
}

export const healthy = (version: string) => () => Response.json({ status: "ok", version });
export const failing = (status = 502) => () => new Response("Bad gateway", { status });
