import { describe, expect, it } from "vitest";
import { parseSnapshot } from "../src/snapshot";
// A real response of infra/agent/agent.py (candlestack repo), with example values.
import fixture from "./fixtures/agent-snapshot.json";

const copy = () => structuredClone(fixture) as Record<string, any>;

describe("parseSnapshot (agent contract, schema 1)", () => {
  it("accepts what the agent sends", () => {
    expect(parseSnapshot(copy())).toEqual(fixture);
  });

  it("accepts the agent's first sample, before CPU can be measured", () => {
    const body = copy();
    body.host.cpu = null;
    expect(parseSnapshot(body)).toBeDefined();
  });

  it("rejects another schema version", () => {
    expect(parseSnapshot({ ...copy(), schema: 2 })).toBeUndefined();
  });

  it("rejects missing or mistyped fields", () => {
    const noHost = copy();
    delete noHost.host;
    const textCpu = copy();
    textCpu.host.cpu = "3.8";
    const badContainer = copy();
    badContainer.containers[0].name = 5;
    for (const body of [noHost, textCpu, badContainer, null, [], "ok"]) {
      expect(parseSnapshot(body)).toBeUndefined();
    }
  });

  it("only takes previews named pr-<N>", () => {
    const body = copy();
    body.previews[0].env = "prod";
    expect(parseSnapshot(body)).toBeUndefined();
  });

  it("refuses oversized lists", () => {
    const body = copy();
    body.containers = Array.from({ length: 101 }, () => fixture.containers[0]);
    expect(parseSnapshot(body)).toBeUndefined();
  });
});
