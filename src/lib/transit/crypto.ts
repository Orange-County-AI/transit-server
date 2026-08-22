const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MASTER_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const HEX_64 = /^[0-9a-f]{64}$/;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("invalid base64 secret material");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function inputBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? textEncoder.encode(value) : value;
}

async function importMasterKey(masterKey: string): Promise<CryptoKey> {
  const raw = base64ToBytes(masterKey);
  if (raw.byteLength !== MASTER_KEY_BYTES) {
    throw new Error("TRANSIT_MASTER_KEY must be base64 for exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function importHmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    inputBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function sealSecret(value: string, masterKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await importMasterKey(masterKey),
      textEncoder.encode(value),
    ),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(ciphertext)}`;
}

export async function openSecret(envelope: string, masterKey: string): Promise<string> {
  const [version, ivEncoded, ciphertextEncoded, extra] = envelope.split(".");
  if (version !== "v1" || !ivEncoded || !ciphertextEncoded || extra !== undefined) {
    throw new Error("invalid sealed secret envelope");
  }

  const iv = base64ToBytes(ivEncoded);
  if (iv.byteLength !== GCM_IV_BYTES) {
    throw new Error("invalid sealed secret IV");
  }

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    await importMasterKey(masterKey),
    base64ToBytes(ciphertextEncoded),
  );
  return textDecoder.decode(plaintext);
}

export async function hmacSign(
  secret: string | Uint8Array,
  value: string | Uint8Array,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(secret),
    inputBytes(value),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function hmacVerify(
  secret: string | Uint8Array,
  value: string | Uint8Array,
  expectedHex: string,
): Promise<boolean> {
  if (!HEX_64.test(expectedHex)) return false;
  return crypto.subtle.verify(
    "HMAC",
    await importHmacKey(secret),
    hexToBytes(expectedHex),
    inputBytes(value),
  );
}

export async function sha256hex(value: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", inputBytes(value));
  return bytesToHex(new Uint8Array(digest));
}
