// What is checked: prod and stage from outside, and the server agent.

const NAMES: Record<string, string> = { prod: "Production", stage: "Staging", vm: "Server" };

export function targetName(id: string): string {
  return NAMES[id] ?? id;
}

/** "main-<40 hex>" reads better as "main · 4330c32". */
export function shortVersion(version: string): string {
  const [, name, sha] = /^(.*)-([0-9a-f]{40})$/.exec(version) ?? [];
  return name && sha ? `${name} · ${sha.slice(0, 7)}` : version;
}

/** 7 min, 2 h 5 min, 3 d 4 h. */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}
