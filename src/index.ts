import { authenticate } from "./access";
import { runChecks } from "./checks";
import { status } from "./status";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    // The page renders bar widths as inline style attributes.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

function withHeaders(response: Response, cacheControl: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set("Cache-Control", cacheControl);
  return new Response(response.body, { status: response.status, headers });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return withHeaders(Response.json(body, init), "no-store");
}

async function health(db: D1Database, now: number): Promise<Response> {
  const row = await db
    .prepare("SELECT MAX(checked_at) AS last FROM targets WHERE id IN ('prod', 'stage')")
    .first<{ last: number | null }>();
  const last = row?.last ?? null;
  // Healthy while the cron keeps checking: at most three missed minutes.
  const ok = last !== null && now - last <= 180;
  return json({ status: ok ? "ok" : "stale", last_check: last }, { status: ok ? 200 : 503 });
}

export default {
  async fetch(request, env) {
    if (!(await authenticate(request, env))) {
      return withHeaders(new Response("Forbidden", { status: 403 }), "no-store");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withHeaders(
        new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } }),
        "no-store",
      );
    }
    const now = Math.floor(Date.now() / 1000);
    switch (new URL(request.url).pathname) {
      case "/api/status":
        return json(await status(env.DB, now));
      case "/api/health":
        return health(env.DB, now);
      default:
        return withHeaders(await env.ASSETS.fetch(request), "no-cache");
    }
  },

  async scheduled(controller, env) {
    await runChecks(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
