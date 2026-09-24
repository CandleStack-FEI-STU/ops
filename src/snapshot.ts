// The contract with the server agent (candlestack repo, infra/agent/agent.py).
// GET <AGENT_URL>/api/snapshot returns schema 1; see README.md, "Agent contract".

import { PREVIEW_RE } from "./targets";

export interface HostMetrics {
  label: string;
  cpus: number;
  /** Seconds since the server booted. */
  uptime: number;
  /** Percent over the last sampling interval; null on the agent's first sample. */
  cpu: number | null;
  load: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
}

export interface Container {
  name: string;
  env: string;
  state: string;
  up: string;
  cpu: number | null;
  mem: number | null;
}

export interface PreviewCheck {
  env: string;
  ok: boolean;
  ms: number | null;
  version: string | null;
}

export interface Snapshot {
  schema: 1;
  /** Unix seconds when the agent took the sample. */
  sampled_at: number;
  host: HostMetrics;
  containers: Container[];
  previews: PreviewCheck[];
}

const MAX_ITEMS = 100;
const MAX_TEXT = 200;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_TEXT;
const isNumberOrNull = (v: unknown) => v === null || isNumber(v);
const isTextOrNull = (v: unknown) => v === null || isText(v);

function isHost(v: unknown): v is HostMetrics {
  return (
    isObject(v) &&
    isText(v.label) &&
    ["cpus", "uptime", "load", "mem_used", "mem_total", "disk_used", "disk_total"].every((k) =>
      isNumber(v[k]),
    ) &&
    isNumberOrNull(v.cpu)
  );
}

function isContainer(v: unknown): v is Container {
  return (
    isObject(v) &&
    isText(v.name) &&
    isText(v.env) &&
    isText(v.state) &&
    isText(v.up) &&
    isNumberOrNull(v.cpu) &&
    isNumberOrNull(v.mem)
  );
}

function isPreviewCheck(v: unknown): v is PreviewCheck {
  return (
    isObject(v) &&
    isText(v.env) &&
    PREVIEW_RE.test(v.env) &&
    typeof v.ok === "boolean" &&
    isNumberOrNull(v.ms) &&
    isTextOrNull(v.version)
  );
}

const isList = <T>(v: unknown, item: (x: unknown) => x is T): v is T[] =>
  Array.isArray(v) && v.length <= MAX_ITEMS && v.every(item);

/** Returns the snapshot if the agent's response matches the contract, otherwise undefined. */
export function parseSnapshot(body: unknown): Snapshot | undefined {
  if (
    isObject(body) &&
    body.schema === 1 &&
    isNumber(body.sampled_at) &&
    isHost(body.host) &&
    isList(body.containers, isContainer) &&
    isList(body.previews, isPreviewCheck)
  ) {
    return body as unknown as Snapshot;
  }
  return undefined;
}
