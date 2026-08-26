import { openSecret, sealSecret } from "./crypto";

export const ATTACHMENT_CAPABILITY_MS = 10 * 60_000;
export const MAX_EVENT_ATTACHMENTS = 16;

export type AttachmentCapability = {
  version: 1;
  org: string;
  integrationId: string;
  eventId: string;
  deliveryId: string;
  index: number;
  expiresAt: number;
};

export async function createAttachmentCapability(
  claims: Omit<AttachmentCapability, "version" | "expiresAt">,
  masterKey: string,
  now = Date.now(),
): Promise<string> {
  return sealSecret(
    JSON.stringify({
      version: 1,
      ...claims,
      expiresAt: now + ATTACHMENT_CAPABILITY_MS,
    } satisfies AttachmentCapability),
    masterKey,
  );
}

export async function readAttachmentCapability(
  token: string,
  masterKey: string,
  now = Date.now(),
): Promise<AttachmentCapability> {
  let value: unknown;
  try {
    value = JSON.parse(await openSecret(token, masterKey));
  } catch {
    throw new Error("invalid_attachment_token");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_attachment_token");
  }
  const claims = value as Partial<AttachmentCapability>;
  if (
    claims.version !== 1 ||
    typeof claims.org !== "string" ||
    !claims.org ||
    typeof claims.integrationId !== "string" ||
    !claims.integrationId ||
    typeof claims.eventId !== "string" ||
    !claims.eventId ||
    typeof claims.deliveryId !== "string" ||
    !claims.deliveryId ||
    !Number.isSafeInteger(claims.index) ||
    claims.index! < 0 ||
    typeof claims.expiresAt !== "number" ||
    !Number.isSafeInteger(claims.expiresAt)
  ) {
    throw new Error("invalid_attachment_token");
  }
  if (claims.expiresAt < now) throw new Error("attachment_token_expired");
  return claims as AttachmentCapability;
}
