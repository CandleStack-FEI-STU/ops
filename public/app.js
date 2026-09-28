// Renders GET /api/status (src/status.ts) and refreshes it every 30 seconds.

document.getElementById("theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
});

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const gb = (b) => (b / 1024 ** 3).toFixed(1);
const mb = (b) => (b >= 1024 ** 3 ? gb(b) + " GB" : Math.round(b / 1024 ** 2) + " MB");
const ago = (s) =>
  s < 90
    ? `${Math.max(0, Math.round(s))} s ago`
    : s < 5400
      ? `${Math.round(s / 60)} min ago`
      : s < 172800
        ? `${Math.round(s / 3600)} h ago`
        : `${Math.round(s / 86400)} d ago`;
const span = (s) =>
  s < 3600
    ? `${Math.max(1, Math.round(s / 60))} min`
    : s < 172800
      ? `${Math.round(s / 3600)} h`
      : `${Math.round(s / 86400)} d`;
// Every time on the page is Bratislava time, like the days of the strips.
const TZ = "Europe/Bratislava";
const time = (ts) =>
  new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dayMonth = (ts) =>
  new Date(ts * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", timeZone: TZ }).replace("/", ".");
const dateOf = (ts) => new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: TZ });
const when = (ts) => dayMonth(ts) + " · " + time(ts);
// "main-<sha>" and "pr-9-<sha>" read better as "main · abc1234".
const version = (v) => {
  if (!v) return null;
  const m = String(v).match(/^(.*)-([0-9a-f]{40})$/);
  return m ? `${m[1]} · ${m[2].slice(0, 7)}` : v;
};

function stateText(t, now) {
  if (t.state === "down") return t.down_since ? `Down · ${span(now - t.down_since)}` : "Down";
  return { up: "Up", warn: "Last check failed", unknown: "No data yet" }[t.state];
}

function stateHtml(state, text) {
  return `<span class="state ${state}"><span class="dot ${state}"></span>${esc(text)}</span>`;
}

function facts(items) {
  return `<span class="facts mono">${items
    .filter(Boolean)
    .map((f) => `<span>${esc(f)}</span>`)
    .join("")}</span>`;
}

function spark(values) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v !== null);
  if (pts.length < 2) return '<span class="mono muted" style="text-align:right">collecting…</span>';
  const w = 96,
    h = 28,
    pad = 2,
    max = 100;
  const x = (i) => (i / 23) * w,
    y = (v) => h - pad - (Math.min(v, max) / max) * (h - pad * 2);
  const line = "M" + pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" L");
  const [li, lv] = pts.at(-1);
  return (
    `<svg class="spark" viewBox="0 0 96 28" role="img" aria-label="Last 24 hours, peak ${Math.round(Math.max(...pts.map((p) => p[1])))}%">` +
    `<path class="area" d="${line} L${x(li)},${h} L${x(pts[0][0])},${h} Z"/><path class="line" d="${line}"/>` +
    `<circle cx="${x(li)}" cy="${y(lv)}" r="2.2"/></svg>`
  );
}

// The outages of one day for its tooltip. An outage across midnight shows on both days,
// with the date on the side that is not this day.
function outageLines(outages, date, now) {
  return outages
    .filter((o) => dateOf(o.started) <= date && date <= dateOf(o.ended ?? now))
    .map((o) => {
      const at = (ts) => (dateOf(ts) === date ? time(ts) : `${dayMonth(ts)} ${time(ts)}`);
      const range = o.ended ? `${at(o.started)}–${at(o.ended)}` : `since ${at(o.started)}`;
      return (
        `<span class="tip-out"><span class="dot down"></span><span>Outage ${range} · ${span((o.ended ?? now) - o.started)}` +
        `<span class="tip-sub">${esc(o.detail ?? "no answer")}</span></span></span>`
      );
    })
    .join("");
}

// One bar per day (Bratislava calendar days); outage minutes are failed checks two or more in a row.
function days(e, now) {
  return (
    `<div class="days" aria-label="Last 30 days">` +
    e.days
      .map((d, i) => {
        const weekday = new Date(d.date + "T12:00:00Z").toLocaleDateString("en-GB", {
          weekday: "short",
          timeZone: "UTC",
        });
        const label = `${weekday} ${d.date.slice(8, 10)}.${d.date.slice(5, 7)}`;
        const up = d.checks ? `${Math.floor(((d.checks - d.down) / d.checks) * 10000) / 100}%` : "no data";
        const lines = d.checks
          ? outageLines(e.outages, d.date, now) || '<span class="tip-ok">No outages</span>'
          : '<span class="tip-ok">No checks yet</span>';
        const side = i < 9 ? "left" : i > 20 ? "right" : "center";
        const aria = `${label}: ${d.down ? `${d.down} min down` : d.checks ? "no outages" : "no data"}`;
        return (
          `<button class="day ${d.mark}" type="button" aria-label="${aria}"><span class="tip ${side}">` +
          `<span class="tip-head"><b>${label}</b><span>${up}</span></span>${lines}</span></button>`
        );
      })
      .join("") +
    `</div>`
  );
}

function envRow(e, now) {
  return `<div class="row"><div class="name"><b>${esc(e.name)}</b><small><a href="https://${esc(e.host)}">${esc(e.host)}</a></small></div>
    <div class="svc"><div class="svc-top">${stateHtml(e.state, stateText(e, now))}
    ${facts([
      e.state === "up" ? null : e.detail,
      e.ms != null ? `${e.ms} ms` : null,
      version(e.version),
      e.uptime30 != null ? `${e.uptime30}% · 30 d` : null,
    ])}</div>
    ${days(e, now)}<div class="days-legend mono"><span>30 days ago</span><span>today</span></div></div></div>`;
}

// Touch screens have no hover: a tap opens the day's tooltip, a tap elsewhere closes it.
document.addEventListener("click", (event) => {
  const day = event.target.closest?.(".day");
  document.querySelectorAll(".day.open").forEach((d) => d !== day && d.classList.remove("open"));
  document.querySelectorAll(".days.picked").forEach((s) => s !== day?.parentElement && s.classList.remove("picked"));
  if (day) {
    day.classList.toggle("open");
    day.parentElement.classList.toggle("picked", day.classList.contains("open"));
  }
});

function headline(s) {
  const [prod, stage] = s.environments;
  if (s.last_check == null) return "Collecting the first checks";
  const down = [stage, ...s.previews].filter((e) => e.state === "down").map((e) => e.name.toLowerCase());
  const problems = [];
  if (down.length) problems.push(`${down.join(" and ")} ${down.length > 1 ? "are" : "is"} down`);
  const serverDown = s.server.state === "down";
  // Prod unreachable from outside and the agent silent: the whole machine (or its tunnel) is gone.
  if (prod.state === "down" && serverDown) return "The server is not reachable";
  if (prod.state === "down") return ["Production is down", ...problems].join(", ");
  if (serverDown) problems.push("the server agent is not responding");
  return problems.length ? `Production is up, ${problems.join(", ")}` : "Everything is up";
}

function serverHtml(v, now) {
  const h = v.host;
  const live = v.state === "up";
  const since = h && !live ? `last data ${time(v.fetched_at)}` : null;
  const vmRight =
    live && h
      ? facts([`${h.cpus} vCPU`, `${gb(h.mem_total)} GB RAM`, `${gb(h.disk_total)} GB disk`, `up ${span(h.uptime)}`])
      : `<div class="svc-top">${stateHtml(v.state, v.state === "down" ? `Not responding · ${span(now - v.down_since)}` : stateText(v, now))}
      ${facts([v.state === "unknown" ? null : v.detail, since])}</div>`;
  let html = `<div class="row"><div class="name"><b>VM</b><small>${esc(h?.label || "candlestack-vm")}</small></div>${vmRight}</div>`;
  if (!h) return html;

  const note = live ? "last 24 h" : `last known · ${time(v.fetched_at)}`;
  const pct = (a, b) => Math.round((a / b) * 100);
  const mem = pct(h.mem_used, h.mem_total),
    disk = pct(h.disk_used, h.disk_total);
  html += `
    <div class="row"><div class="name"><b>CPU</b><small>${note}</small></div>
      <div class="metric"><div><div class="metric-head"><span class="mono">${h.cpu != null ? Math.round(h.cpu) + "%" : "—"}</span><span class="mono muted">load ${h.load.toFixed(2)}</span></div>
      <div class="bar"><span style="width:${Math.min(100, h.cpu ?? 0)}%"></span></div></div>${spark(v.cpu_24h)}</div></div>
    <div class="row"><div class="name"><b>Memory</b><small>${note}</small></div>
      <div class="metric"><div><div class="metric-head"><span class="mono">${gb(h.mem_used)} / ${gb(h.mem_total)} GB</span><span class="mono muted">${mem}%</span></div>
      <div class="bar"><span class="${mem > 85 ? "warn" : ""}" style="width:${mem}%"></span></div></div>${spark(v.mem_24h)}</div></div>
    <div class="row"><div class="name"><b>Disk</b><small>${live ? "/" : note}</small></div>
      <div class="metric"><div><div class="metric-head"><span class="mono">${gb(h.disk_used)} / ${gb(h.disk_total)} GB</span><span class="mono ${disk > 80 ? "" : "muted"}" style="${disk > 80 ? "color:var(--warn)" : ""}">${disk}%</span></div>
      <div class="bar"><span class="${disk > 80 ? "warn" : ""}" style="width:${disk}%"></span></div></div>
      <span class="mono muted" style="text-align:right">${v.disk_per_day != null ? (v.disk_per_day >= 0 ? "+" : "") + gb(v.disk_per_day) + " GB/d" : ""}</span></div></div>`;
  return html;
}

let lastEnvs = "";

function render(s) {
  const [prod, stage] = s.environments;
  const now = s.now;
  $("headline").textContent = headline(s);
  const late = s.last_check != null && now - s.last_check > s.interval * 3;
  const warn =
    late ||
    [stage, ...s.previews].some((e) => e.state === "down" || e.state === "warn") ||
    prod.state === "warn" ||
    s.server.state !== "up";
  $("overall-dot").className =
    "dot " + (s.last_check == null ? "unknown" : prod.state === "down" ? "down" : warn ? "warn" : "up");
  $("overall-text").textContent =
    s.last_check == null
      ? "Waiting for the first check"
      : `${late ? "Checks are late" : "Checked every minute from Cloudflare"} · last check ${ago(now - s.last_check)}`;

  // Previews are reported by the agent: without it, the list is only the last known one.
  const pv = s.previews,
    known = s.server.state === "up";
  // Rebuilt only when the content changed (at most once a minute), so a refresh does not close an open tooltip.
  const pvState = !known
    ? "unknown"
    : pv.some((p) => p.state === "down")
      ? "down"
      : pv.some((p) => p.state === "warn")
        ? "warn"
        : "up";
  const pvText =
    (pv.length ? `${pv.length} running` : "None running") +
    (known || !s.server.fetched_at ? "" : ` · last known ${time(s.server.fetched_at)}`);
  const envs =
    envRow(prod, now) +
    envRow(stage, now) +
    `<div class="row"><div class="name"><b>PR previews</b><small>pr-&lt;N&gt;-preview.candlestack.tech</small></div>
    <div class="svc-top">${stateHtml(pvState, pvText)}
    <span class="facts mono">${pv.map((p) => `<a href="https://${esc(p.host)}">${esc(p.env)}</a>`).join("")}</span></div></div>`;
  if (envs !== lastEnvs) $("envs").innerHTML = lastEnvs = envs;

  $("sources").innerHTML = s.sources?.length
    ? s.sources
        .map(
          (src) =>
            `<div class="row"><div class="name"><b>${esc(src.name)}</b><small>${esc(src.host || "")}</small></div>
    <div class="svc-top">${stateHtml(src.ok ? "up" : "warn", src.ok ? "Up" : "Not responding")}
    ${facts([`last good fetch ${ago(now - src.last_success)}`])}</div></div>`,
        )
        .join("")
    : `<p class="empty">The app does not report its data sources yet. They appear here once it serves <span class="mono">/api/health/sources</span>.</p>`;

  $("server").innerHTML = serverHtml(s.server, now);

  const live = s.server.state === "up";
  $("h-ct").textContent =
    live || !s.server.fetched_at ? "Containers" : `Containers · last known ${time(s.server.fetched_at)}`;
  $("containers").innerHTML = s.containers
    .map(
      (c) =>
        `<tr><td><span class="state" style="font-weight:400"><span class="dot ${!live ? "unknown" : c.state === "running" ? "" : "down"}"></span>${esc(c.name)}</span></td>
    <td class="env">${esc(c.env)}</td><td class="num mono">${c.cpu != null ? c.cpu.toFixed(1) + "%" : "—"}</td>
    <td class="num mono">${c.mem != null ? mb(c.mem) : "—"}</td><td class="num mono muted hide-sm">${esc(c.up)}</td></tr>`,
    )
    .join("");

  $("events").innerHTML = s.events.length
    ? s.events
        .map(
          (e) =>
            `<li class="row"><span class="mono muted">${when(e.ts)}</span><span>${esc(e.message)} <span class="muted">· ${esc(e.source)}</span></span></li>`,
        )
        .join("")
    : `<li class="empty">Nothing has happened yet.</li>`;
}

async function refresh() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    render(await r.json());
  } catch (err) {
    $("headline").textContent = "Could not load the status";
    $("overall-dot").className = "dot down";
    $("overall-text").textContent = "Retrying every 30 s · reload the page if your sign-in expired";
  }
}
refresh();
setInterval(refresh, 30000);
