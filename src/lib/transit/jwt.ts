/**
 * The smallest HS256 JWT that does the job, hand-rolled on WebCrypto.
 *
 * Transit issues exactly one kind of token and verifies it itself, so there is
 * no key discovery, no algorithm agility and no JWKS to fetch. That is the
 * point: `alg` is not read from the header, because an attacker-chosen
 * algorithm is the classic way a JWT library gets turned into a forgery
 * oracle. This verifier only ever computes HS256 and compares.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64urlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(secret: string | Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    typeof secret === "string" ? textEncoder.encode(secret) : secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export type JwtClaims = Record<string, unknown> & {
  iss?: string;
  sub?: string;
  aud?: string;
  exp?: number;
  iat?: number;
};

export async function signJwt(
  claims: JwtClaims,
  secret: string | Uint8Array,
): Promise<string> {
  const header = base64urlEncode(
    textEncoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payload = base64urlEncode(textEncoder.encode(JSON.stringify(claims)));
  const signed = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await signingKey(secret), textEncoder.encode(signed)),
  );
  return `${signed}.${base64urlEncode(signature)}`;
}

/** Whether a bearer even looks like a JWT, without trusting anything in it. */
export function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

/**
 * Verifies the signature and the time bounds, and returns the claims. Returns
 * null on any failure — a caller that cannot tell "expired" from "forged"
 * cannot leak the difference to an attacker either.
 */
export async function verifyJwt(
  token: string,
  secret: string | Uint8Array,
  options: { now?: number; leewaySeconds?: number } = {},
): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      base64urlDecode(signature),
      textEncoder.encode(`${header}.${payload}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let claims: JwtClaims;
  try {
    claims = JSON.parse(textDecoder.decode(base64urlDecode(payload))) as JwtClaims;
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    return null;
  }

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const leeway = options.leewaySeconds ?? 60;
  // An absent `exp` is not "never expires" here: every token this server issues
  // has one, so a token without one did not come from this server's issuer path.
  if (typeof claims.exp !== "number" || claims.exp + leeway < now) return null;
  if (typeof claims.iat === "number" && claims.iat - leeway > now) return null;
  return claims;
}
