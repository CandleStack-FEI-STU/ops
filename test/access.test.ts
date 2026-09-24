import { beforeAll, describe, expect, it } from "vitest";
import { verifyJwt } from "../src/access";

const AUD = "test-aud";
const ISSUER = "https://candlestack.cloudflareaccess.com";
const NOW = 1_790_000_000;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

let signing: CryptoKeyPair;
let other: CryptoKeyPair;

async function keyPair() {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function token(claims: Record<string, unknown>, key = signing.privateKey, header: Record<string, unknown> = {}) {
  const head = encode({ alg: "RS256", kid: "k1", typ: "JWT", ...header });
  const body = encode({ aud: [AUD], iss: ISSUER, iat: NOW - 10, exp: NOW + 3600, ...claims });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(new Uint8Array(signature))}`;
}

const verify = (jwt: string) =>
  verifyJwt(jwt, {
    aud: AUD,
    issuer: ISSUER,
    now: NOW,
    keys: async (kid) => (kid === "k1" ? signing.publicKey : undefined),
  });

beforeAll(async () => {
  signing = await keyPair();
  other = await keyPair();
});

describe("verifyJwt", () => {
  it("accepts a person signed in through Access", async () => {
    expect(await verify(await token({ email: "dev@example.com" }))).toEqual({
      email: "dev@example.com",
      serviceToken: undefined,
    });
  });

  it("accepts a service token", async () => {
    expect(await verify(await token({ common_name: "abc.access", email: "" }))).toEqual({
      email: undefined,
      serviceToken: "abc.access",
    });
  });

  it("rejects another application's token", async () => {
    expect(await verify(await token({ aud: ["other-aud"] }))).toBeUndefined();
  });

  it("rejects another issuer", async () => {
    expect(await verify(await token({ iss: "https://evil.cloudflareaccess.com" }))).toBeUndefined();
  });

  it("rejects an expired token", async () => {
    expect(await verify(await token({ exp: NOW - 120 }))).toBeUndefined();
  });

  it("rejects a token that is not valid yet", async () => {
    expect(await verify(await token({ nbf: NOW + 600 }))).toBeUndefined();
  });

  it("rejects a signature from another key", async () => {
    expect(await verify(await token({}, other.privateKey))).toBeUndefined();
  });

  it("rejects an unknown key id", async () => {
    expect(await verify(await token({}, signing.privateKey, { kid: "k2" }))).toBeUndefined();
  });

  it("rejects unsigned tokens", async () => {
    const head = encode({ alg: "none", kid: "k1" });
    const body = encode({ aud: [AUD], iss: ISSUER, exp: NOW + 3600 });
    expect(await verify(`${head}.${body}.`)).toBeUndefined();
  });

  it("rejects garbage", async () => {
    expect(await verify("not.a.jwt")).toBeUndefined();
    expect(await verify("")).toBeUndefined();
  });
});
