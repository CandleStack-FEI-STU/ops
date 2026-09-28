import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { localDay, runChecks, snapshotEvents, transition, type CheckResult, type TargetState } from "../src/checks";
import type { Container } from "../src/snapshot";
import { status } from "../src/status";
import { failing, fakeFetch, healthy, minute, resetDb, seconds, snapshot } from "./helpers";

const PROD = "https://app.candlestack.tech/api/health";
const STAGE = "https://stage.candlestack.tech/api/health";
const AGENT = "https://vm.candlestack.tech/api/snapshot";

const ok = (target: string, version: string | null = null): CheckResult => ({
  target,
  ok: true,
  ms: 40,
  version,
  detail: null,
});
const bad = (target: string, detail = "HTTP 502"): CheckResult => ({
  target,
  ok: false,
  ms: 40,
  version: null,
  detail,
});

function state(overrides: Partial<TargetState>): TargetState {
  return {
    id: "prod",
    ok: 1,
    ms: 40,
    version: "v0.1.0",
    detail: null,
    checked_at: 0,
    fails: 0,
    down_since: null,
    ...overrides,
  };
}

function stageApp(overrides: Partial<Container>): Container {
  return {
    name: "app",
    env: "stage",
    state: "running",
    up: "1 hour",
    cpu: 0,
    mem: 1,
    created: 1000,
    started: 1000,
    version: "main-" + "1".repeat(40),
    ...overrides,
  };
}

const stageBackend = (overrides: Partial<Container>) => stageApp({ name: "backend", ...overrides });

describe("transition", () => {
  it("opens an outage on the second failed check in a row and counts both minutes", () => {
    const first = transition(state({}), bad("prod"), 1000);
    expect(first).toMatchObject({ events: [], outage: null, down: 0 });
    expect(first.next).toMatchObject({ ok: 0, fails: 1, down_since: null });

    const second = transition(first.next, bad("prod"), 1060);
    expect(second).toMatchObject({ outage: "opened", down: 2 });
    expect(second.next).toMatchObject({ fails: 2, down_since: 1000 });
    expect(second.events).toEqual([
      { ts: 1060, target: "prod", source: "health check", message: "Production stopped responding (HTTP 502)" },
    ]);

    expect(transition(second.next, bad("prod"), 1120)).toMatchObject({ events: [], outage: null, down: 1 });
  });

  it("does not count a single failed check", () => {
    const blip = transition(state({}), bad("prod"), 1000);
    const back = transition(blip.next, ok("prod", "v0.1.0"), 1060);
    expect([blip.down, back.down, back.outage, back.events]).toEqual([0, 0, null, []]);
  });

  it("closes the outage and reports how long it lasted", () => {
    const { next, events, outage } = transition(
      state({ ok: 0, fails: 5, down_since: 1000 }),
      ok("prod", "v0.1.0"),
      1000 + 125 * 60,
    );
    expect(next).toMatchObject({ ok: 1, fails: 0, down_since: null });
    expect(outage).toBe("closed");
    expect(events.map((e) => e.message)).toEqual(["Production recovered after 2 h 5 min"]);
  });

  it("keeps the version without an event: deploys come from the agent", () => {
    const { next, events } = transition(state({ id: "stage", version: "main-1" }), ok("stage", "main-2"), 1000);
    expect([next.version, events]).toEqual(["main-2", []]);
  });

  it("reports a new preview, even when its first check fails", () => {
    expect(transition(undefined, bad("pr-12", "unhealthy"), 1000).events.map((e) => e.message)).toEqual([
      "Preview pr-12 started",
    ]);
  });
});

describe("localDay", () => {
  it("uses the calendar day in Bratislava", () => {
    const sept24 = Date.UTC(2026, 8, 24) / 86_400_000;
    expect(localDay(Date.UTC(2026, 8, 23, 22, 30) / 1000)).toBe(sept24); // 00:30 in Bratislava
    expect(localDay(Date.UTC(2026, 8, 24, 21, 59) / 1000)).toBe(sept24); // 23:59 in Bratislava
    expect(localDay(Date.UTC(2026, 8, 24, 22, 0) / 1000)).toBe(sept24 + 1);
  });
});

describe("snapshotEvents", () => {
  const at = (containers: Container[], sampledAt = 5000, uptime = 4000) => {
    const s = snapshot(sampledAt, [], containers);
    s.host.uptime = uptime;
    return s;
  };
  const v2 = "main-4330c32" + "0".repeat(33);

  it("needs a previous snapshot", () => {
    expect(snapshotEvents(undefined, at([stageApp({})]))).toEqual([]);
  });

  it("tells a deploy (new version) from a redeploy (same version)", () => {
    const before = at([stageApp({})]);
    expect(snapshotEvents(before, at([stageApp({ created: 2000, started: 2000, version: v2 })]))).toEqual([
      { ts: 2000, target: "stage", source: "deploy", message: "Staging deployed main · 4330c32" },
    ]);
    expect(snapshotEvents(before, at([stageApp({ created: 2000, started: 2000 })]))).toEqual([
      { ts: 2000, target: "stage", source: "deploy", message: "Staging redeployed main · 1111111" },
    ]);
  });

  it("reports a restart of the same container", () => {
    expect(snapshotEvents(at([stageApp({})]), at([stageApp({ started: 3000 })]))).toEqual([
      { ts: 3000, target: "stage", source: "restart", message: "Staging restarted" },
    ]);
  });

  it("tells a container that came back after being down from a new one", () => {
    expect(snapshotEvents(at([]), at([stageApp({ started: 3000 })]))[0]).toMatchObject({
      message: "Staging restarted",
    });
    expect(snapshotEvents(at([]), at([stageApp({ started: 1002 })]))[0]).toMatchObject({
      message: "Staging deployed main · 1111111",
    });
  });

  it("reports a reboot when the boot time moves forward", () => {
    expect(snapshotEvents(at([], 5000, 4000), at([], 5060, 4060))).toEqual([]);
    expect(snapshotEvents(at([], 5000, 4000), at([], 5060, 30))).toEqual([
      { ts: 5030, target: "vm", source: "server", message: "Server rebooted" },
    ]);
  });

  it("follows the backend container of an environment", () => {
    const before = at([stageBackend({})]);
    expect(snapshotEvents(before, at([stageBackend({ created: 2000, started: 2000, version: v2 })]))).toEqual([
      { ts: 2000, target: "stage", source: "deploy", message: "Staging deployed main · 4330c32" },
    ]);
    expect(snapshotEvents(before, at([stageBackend({ started: 3000 })]))).toEqual([
      { ts: 3000, target: "stage", source: "restart", message: "Staging restarted" },
    ]);
  });

  it("still follows the app container where no backend runs", () => {
    expect(snapshotEvents(at([stageApp({})]), at([stageApp({ created: 2000, started: 2000, version: v2 })]))).toEqual([
      { ts: 2000, target: "stage", source: "deploy", message: "Staging deployed main · 4330c32" },
    ]);
  });

  it("follows the backend when an environment runs both backend and app", () => {
    const before = at([stageApp({}), stageBackend({ created: 1500, started: 1500, version: v2 })]);
    const appChanged = at([
      stageApp({ created: 2000, started: 2000 }),
      stageBackend({ created: 1500, started: 1500, version: v2 }),
    ]);
    expect(snapshotEvents(before, appChanged)).toEqual([]);
    const backendChanged = at([stageApp({}), stageBackend({ created: 2500, started: 2500, version: v2 })]);
    expect(snapshotEvents(before, backendChanged)).toEqual([
      { ts: 2500, target: "stage", source: "deploy", message: "Staging redeployed main · 4330c32" },
    ]);
  });

  it("reports the switch from app to backend as a deploy and ignores the other services", () => {
    const frontend = stageApp({ name: "frontend", created: 2000, started: 2000, version: v2 });
    const redis = stageApp({ name: "redis", created: 1990, started: 1990, version: null });
    const after = at([stageBackend({ created: 2000, started: 2000, version: v2 }), frontend, redis]);
    expect(snapshotEvents(at([stageApp({})]), after)).toEqual([
      { ts: 2000, target: "stage", source: "deploy", message: "Staging deployed main · 4330c32" },
    ]);
    // Only the backend counts: a restart of redis or the frontend is not an event.
    const restarted = at([
      stageBackend({ created: 2000, started: 2000, version: v2 }),
      { ...frontend, started: 3000 },
      { ...redis, started: 3000 },
    ]);
    expect(snapshotEvents(after, restarted)).toEqual([]);
  });

  it("stays quiet with an agent that does not report container times", () => {
    const old = { name: "app", env: "stage", state: "running", up: "1 hour", cpu: 0, mem: 1 };
    expect(snapshotEvents(at([old]), at([old]))).toEqual([]);
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

  it("records an outage with its minutes, times and cause", async () => {
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
    expect(prod.days.at(-1)).toEqual({ date: "2026-09-24", checks: 5, down: 3, mark: "outage" });
    expect(prod.days[0]!.mark).toBe("none");
    expect(prod.outages).toEqual([{ started: seconds(minute(1)), ended: seconds(minute(4)), detail: "HTTP 502" }]);
    expect(s.environments[1]!.outages).toEqual([]);
    expect(s.events.map((e) => e.message)).toEqual([
      "Production recovered after 3 min",
      "Production stopped responding (HTTP 502)",
    ]);
  });

  it("shows an outage that is still going on without an end", async () => {
    const { fetcher } = fakeFetch({
      [PROD]: failing(502),
      [STAGE]: healthy("main-abc"),
      [AGENT]: () => Response.json(snapshot(seconds(minute(0)))),
    });
    await runChecks(env, minute(0), fetcher);
    await runChecks(env, minute(1), fetcher);
    const prod = (await status(env.DB, seconds(minute(1)))).environments[0]!;
    expect(prod).toMatchObject({ state: "down", down_since: seconds(minute(0)) });
    expect(prod.outages).toEqual([{ started: seconds(minute(0)), ended: null, detail: "HTTP 502" }]);
  });

  it("does not count a single failed check as an outage", async () => {
    let prodUp = false;
    const { fetcher } = fakeFetch({
      [PROD]: () => (prodUp ? healthy("v0.1.0")() : failing(502)()),
      [STAGE]: healthy("main-abc"),
      [AGENT]: () => Response.json(snapshot(seconds(minute(0)))),
    });
    await runChecks(env, minute(0), fetcher);
    prodUp = true;
    await runChecks(env, minute(1), fetcher);
    const prod = (await status(env.DB, seconds(minute(1)))).environments[0]!;
    expect(prod.days.at(-1)).toMatchObject({ checks: 2, down: 0, mark: "up" });
    expect([prod.uptime30, prod.outages]).toEqual([100, []]);
  });

  it("records deploys and redeploys from the agent's containers", async () => {
    let stage = stageApp({ created: seconds(minute(0)) - 600, started: seconds(minute(0)) - 600 });
    const { fetcher } = fakeFetch({
      [PROD]: healthy("v0.1.0"),
      [STAGE]: healthy("main-abc"),
      [AGENT]: () => Response.json(snapshot(seconds(minute(0)), [], [stage])),
    });
    await runChecks(env, minute(0), fetcher);
    stage = { ...stage, created: seconds(minute(1)) - 5, started: seconds(minute(1)) - 5 };
    const events = await runChecks(env, minute(1), fetcher);
    expect(events.map((e) => e.message)).toEqual(["Staging redeployed main · 1111111"]);
    expect((await status(env.DB, seconds(minute(1)))).events[0]).toMatchObject({
      source: "deploy",
      message: "Staging redeployed main · 1111111",
    });
  });

  it("records deploys of prod still on app and stage already on backend", async () => {
    const created = seconds(minute(0)) - 600;
    let prod = stageApp({ env: "prod", created, started: created, version: "v0.1.0" });
    let stage = stageBackend({ created, started: created });
    const { fetcher } = fakeFetch({
      [PROD]: healthy("v0.1.0"),
      [STAGE]: healthy("main-abc"),
      [AGENT]: () => Response.json(snapshot(seconds(minute(0)), [], [prod, stage])),
    });
    await runChecks(env, minute(0), fetcher);
    const deployed = seconds(minute(1)) - 5;
    prod = { ...prod, created: deployed, started: deployed, version: "v0.2.0" };
    stage = { ...stage, created: deployed, started: deployed, version: "main-4330c32" + "0".repeat(33) };
    const events = await runChecks(env, minute(1), fetcher);
    expect(events.map((e) => e.message)).toEqual(["Production deployed v0.2.0", "Staging deployed main · 4330c32"]);
  });

  it("marks the server down when the agent stops answering and keeps the last data", async () => {
    let agentUp = true;
    const { fetcher } = fakeFetch({
      [PROD]: healthy("v0.1.0"),
      [STAGE]: healthy("main-abc"),
      [AGENT]: () =>
        agentUp
          ? Response.json(snapshot(seconds(minute(0)), [{ env: "pr-12", ok: true, ms: 3, version: "pr-12-x" }]))
          : new Error("timeout"),
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
    // The server has no strip: its outages only become events.
    expect(s.environments.flatMap((e) => e.outages)).toEqual([]);
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
      [STAGE]: () =>
        new Response(null, { status: 302, headers: { Location: "https://candlestack.cloudflareaccess.com/" } }),
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
