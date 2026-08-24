const ID_BYTES = 6;
const ENROLL_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function prefixedId(prefix: string): string {
  const hex = Array.from(randomBytes(ID_BYTES), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${prefix}_${hex}`;
}

export const txId = (): string => prefixedId("tx");
export const dlvId = (): string => prefixedId("dlv");
export const hostId = (): string => prefixedId("hst");
export const intId = (): string => prefixedId("int");
export const eventId = (): string => prefixedId("evt");
export const agentClientId = (): string => prefixedId("agc");
function randomToken(): string {
  const binary = String.fromCharCode(...randomBytes(32));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export const deviceToken = (): string => randomToken();
export const sourceSecret = (): string => randomToken();
/** An agent client's secret. Same 32 random bytes a device token gets. */
export const agentClientSecret = (): string => randomToken();


export function enrollCode(): string {
  const unbiasedCeiling = 256 - (256 % ENROLL_ALPHABET.length);
  let code = "";
  while (code.length < 8) {
    for (const byte of randomBytes(8 - code.length)) {
      if (byte >= unbiasedCeiling) continue;
      code += ENROLL_ALPHABET[byte % ENROLL_ALPHABET.length];
    }
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
