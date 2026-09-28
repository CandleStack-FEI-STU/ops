// Cloudflare Access signs every request it lets through with a JWT in the
// Cf-Access-Jwt-Assertion header. Checking it here keeps the page and the API closed
// even if the hostname were ever served without Access in front of it.

export interface Identity {
  /** A person who signed in with GitHub. */
  email?: string;
  /** A service token, such as the one CI uses for its health check. */
  serviceToken?: string;
}

export type KeyLookup = (kid: string) => Promise<CryptoKey | undefined>;

interface VerifyOptions {
  aud: string;
  issuer: string;
  keys: KeyLookup;
  /** Unix seconds. */
  now: number;
}

const CLOCK_SKEW = 60;

function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64url(value)));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyJwt(token: string, options: VerifyOptions): Promise<Identity | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [head, body, signature] = parts as [string, string, string];
  const header = decodeJson(head);
  const claims = decodeJson(body);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return undefined;

  const key = await options.keys(header.kid);
  if (!key) return undefined;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64url(signature),
      new TextEncoder().encode(`${head}.${body}`),
    );
  } catch {
    return undefined;
  }
  if (!valid) return undefined;

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.aud) || claims.iss !== options.issuer) return undefined;
  if (typeof claims.exp !== "number" || claims.exp <= options.now - CLOCK_SKEW) return undefined;
  if (typeof claims.nbf === "number" && claims.nbf > options.now + CLOCK_SKEW) return undefined;

  return {
    email: typeof claims.email === "string" && claims.email ? claims.email : undefined,
    serviceToken: typeof claims.common_name === "string" && claims.common_name ? claims.common_name : undefined,
  };
}

// Access rotates its signing keys every six weeks and publishes both the current and the
// next key, so an hour of caching per isolate is safe. An unknown key id triggers a refetch,
// at most once a minute.
const CERTS_TTL_MS = 60 * 60 * 1000;
const REFETCH_MS = 60 * 1000;
let certs: { domain: string; keys: Map<string, CryptoKey>; fetchedAt: number } | undefined;

async function fetchKeys(domain: string, fetcher: typeof fetch): Promise<Map<string, CryptoKey>> {
  const response = await fetcher(`https://${domain}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Access certs: HTTP ${response.status}`);
  const { keys } = await response.json<{ keys: (JsonWebKey & { kid: string })[] }>();
  const imported = await Promise.all(
    keys.map(async (jwk) => {
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "verify",
      ]);
      return [jwk.kid, key] as const;
    }),
  );
  return new Map(imported);
}

export function accessKeys(domain: string, fetcher: typeof fetch = fetch): KeyLookup {
  return async (kid) => {
    const now = Date.now();
    const age = certs?.domain === domain ? now - certs.fetchedAt : Infinity;
    if (age > CERTS_TTL_MS || (!certs?.keys.has(kid) && age > REFETCH_MS)) {
      certs = { domain, keys: await fetchKeys(domain, fetcher), fetchedAt: now };
    }
    return certs?.keys.get(kid);
  };
}

export async function authenticate(request: Request, env: Env): Promise<Identity | undefined> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return undefined;
  return verifyJwt(token, {
    aud: env.ACCESS_AUD,
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
    keys: accessKeys(env.ACCESS_TEAM_DOMAIN),
    now: Math.floor(Date.now() / 1000),
  });
}
