import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runChecks, transition, type CheckResult, type TargetState } from "../src/checks";
import { status } from "../src/status";
import { failing, fakeFetch, healthy, minute, resetDb, seconds, snapshot } from "./helpers";

const PROD = "https://app.candlestack.tech/api/health";
const STAGE = "https://stage.candlestack.tech/api/health";
const AGENT = "https://vm.candlestack.tech/api/snapshot";

const ok = (target: string, version: string | null = null): CheckResult => ({
  target, ok: true, ms: 40, version, detail: null,
});
const bad = (target: string, detail = "HTTP 502"): CheckResult => ({
  target, ok: false, ms: 40, version: null, detail,
});

function state(overrides: Partial<TargetState>): TargetState {
  return { id: "prod", ok: 1, ms: 40, version: "v0.1.0", detail: null, checked_at: 0, fails: 0, down_since: null, ...overrides };
}

describe("transition", () => {
  it("reports an outage only after two failed checks in a row", () => {
    const first = transition(state({}), bad("prod"), 1000);
    expect(first.events).toEqual([]);
    expect(first.next).toMatchObject({ ok: 0, fails: 1, down_since: null });

    const second = transition(first.next, bad("prod"), 1060);
    expect(second.next).toMatchObject({ fails: 2, down_since: 1000 });
    expect(second.events).toEqual([
      { ts: 1060, target: "prod", source: "health check", message: "Production stopped responding (HTTP 502)" },
    ]);
    expect(transition(second.next, bad("prod"), 1120).events).toEqual([]);
  });

  it("reports the length of the outage on recovery", () => {
    const { next, events } = transition(state({ ok: 0, fails: 5, down_since: 1000 }), ok("prod", "v0.1.0"), 1000 + 125 * 60);
    expect(next).toMatchObject({ ok: 1, fails: 0, down_since: null });
    expect(events.map((e) => e.message)).toEqual(["Production recovered after 2 h 5 min"]);
  });

  it("reports a new version as a deploy", () => {
    const sha = "4330c32" + "0".repeat(33);
    const { next, events } = transition(state({ id: "stage", version: "main-" + "1".repeat(40) }), ok("stage", `main-${sha}`), 1000);
    expect(next.version).toBe(`main-${sha}`);
    expect(events).toEqual([{ ts: 1000, target: "stage", source: "deploy", message: "Staging deployed main · 4330c32" }]);
  });

  it("does not call the first check a deploy", () => {
    expect(transition(undefined, ok("prod", "v0.1.0"), 1000).events).toEqual([]);
  });

  it("reports a new preview, even when its first check fails", () => {
    expect(transition(undefined, bad("pr-12", "unhealthy"), 1000).events.map((e) => e.message)).toEqual([
      "Preview pr-12 started",
    ]);
  });
});

describe("runChecks", () => {
  beforeEach(resetDb);

  it("checks prod publicly and stage and the agent with the Access service token", async () => {
    const { fetcher, requests } = fakeFetch({
      [PROD]: healthy("v0.1.0"),
      [STAGE]: healthy("main-abc"),
      [AGENT]: () => Response.json(snapshot(seconds(minute(0)) - 20)),
    });
    await runChecks(env, minute(0), fetcher);

    const byUrl = new Map(requests.map((r) => [r.url, r]));
    expect(byUrl.get(PROD)!.headers.get("CF-Access-Client-Id")).toBeNull();
    for (const url of [STAGE, AGENT]) {
      expect(byUrl.get(url)!.headers.get("CF-Access-Client-Id")).toBe("test-client-id");
      expect(byUrl.get(url)!.headers.get("CF-Access-Client-Secret")).toBe("test-client-secret");
    }
    expect(byUrl.get(PROD)!.headers.get("User-Agent")).toMatch(/^candlestack-ops\//);
    expect(byUrl.get(PROD)!.redirect).toBe("manual");
  });

  it("records an outage and its recovery with a day and uptime", async () => {
    let prodUp = true;
    const { fetcher } = fakeFetch({
      [PROD]: () => (prodUp ? healthy("v0.1.0")() : failing(502)()),
      [STAGE]: healthy("main-abc"),
      [AGENT]: () => Response.json(snapshot(seconds(minute(0)))),
    });
    await runChecks(env, minute(0), fetcher);
    prodUp = false;
    await runChecks(env, minute(1), fetcher);
    await runChecks(env, minute(2), fetcher);
    await runChecks(env, minute(3), fetcher);
    prodUp = true;
    const events = await runChecks(env, minute(4), fetcher);
    expect(events.map((e) => e.message)).toEqual(["Production recovered after 3 min"]);

    const s = await status(env.DB, seconds(minute(4)) + 10);
    const prod = s.environments[0]!;
    expect(prod.state).toBe("up");
    expect(prod.uptime30).toBe(40);
    expect(prod.days.at(-1)).toEqual({ date: "2026-09-24", checks: 5, failed: 3, mark: "warn" });
    expect(prod.days[0]!.mark).toBe("none");
    expect(s.events.map((e) => e.message)).toEqual([
      "Production recovered after 3 min",
      "Production stopped responding (HTTP 502)",
    ]);
  });

  it("marks the server down when the agent stops answering and keeps the last data", async () => {
    let agentUp = true;
    const { fetcher } = fakeFetch({
      [PROD]: healthy("v0.1.0"),
      [STAGE]: healthy("main-abc"),
      [AGENT]: () => (agentUp ? Response.json(snapshot(seconds(minute(0)), [{ env: "pr-12", ok: true, ms: 3, version: "pr-12-x" }])) : new Error("timeout")),
    });
    await runChecks(env, minute(0), fetcher);
    agentUp = false;
    await runChecks(env, minute(1), fetcher);
    const events = await runChecks(env, minute(2), fetcher);
    expect(events.map((e) => e.message)).toEqual(["Server stopped responding (unreachable)"]);

    const s = await status(env.DB, seconds(minute(2)));
    expect(s.server).toMatchObject({ state: "down", detail: "unreachable", fetched_at: seconds(minute(0)) });
    expect(s.server.host?.cpus).toBe(2);
    // Without the agent nobody knows whether previews are gone, so they stay as they were.
    expect(s.previews.map((p) => [p.env, p.state])).toEqual([["pr-12", "up"]]);
  });

  it("treats an old or malformed snapshot as the agent failing", async () => {
    let body: unknown = snapshot(seconds(minute(0)) - 600);
    const { fetcher } = fakeFetch({
      [PROD]: healthy("v0.1.0"),
      [STAGE]: healthy("main-abc"),
      [AGENT]: () => Response.json(body),
    });
    await runChecks(env, minute(0), fetcher);
    let s = await status(env.DB, seconds(minute(0)));
    expect(s.server).toMatchObject({ state: "warn", detail: "stale data", host: null });

    body = { schema: 2 };
    await runChecks(env, minute(1), fetcher);
    s = await status(env.DB, seconds(minute(1)));
    expect(s.server).toMatchObject({ state: "down", detail: "unexpected response" });
  });

  it("follows previews as they start and go", async () => {
    let previews = [{ env: "pr-12", ok: true, ms: 3, version: "pr-12-x" }];
    const { fetcher } = fakeFetch({
      [PROD]: healthy("v0.1.0"),
      [STAGE]: healthy("main-abc"),
      [AGENT]: () => Response.json(snapshot(seconds(minute(0)), previews)),
    });
    expect((await runChecks(env, minute(0), fetcher)).map((e) => e.message)).toEqual(["Preview pr-12 started"]);
    previews = [];
    expect((await runChecks(env, minute(1), fetcher)).map((e) => e.message)).toEqual(["Preview pr-12 removed"]);
    expect((await status(env.DB, seconds(minute(1)))).previews).toEqual([]);
  });

  it("counts a redirect to the Access login as a failed check", async () => {
    const { fetcher } = fakeFetch({
      [PROD]: healthy("v0.1.0"),
      [STAGE]: () => new Response(null, { status: 302, headers: { Location: "https://candlestack.cloudflareaccess.com/" } }),
      [AGENT]: () => Response.json(snapshot(seconds(minute(0)))),
    });
    await runChecks(env, minute(0), fetcher);
    const stage = (await status(env.DB, seconds(minute(0)))).environments[1]!;
    expect(stage).toMatchObject({ state: "warn", detail: "Access rejected the check" });
  });

  it("builds 24-hour server charts from hourly sums", async () => {
    const { fetcher } = fakeFetch({
      [PROD]: healthy("v0.1.0"),
      [STAGE]: healthy("main-abc"),
      [AGENT]: () => Response.json(snapshot(seconds(minute(0)))),
    });
    await runChecks(env, minute(0), fetcher);
    await runChecks(env, minute(1), fetcher);
    const s = await status(env.DB, seconds(minute(1)));
    expect(s.server.cpu_24h).toHaveLength(24);
    expect(s.server.cpu_24h.at(-1)).toBe(12.5);
    expect(s.server.mem_24h.at(-1)).toBe(50);
    expect(s.server.cpu_24h[0]).toBeNull();
    expect(s.containers).toHaveLength(1);
  });
});
