export const SOURCE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function validateReplyPrefix(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("reply prefix must be a URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !value.endsWith("/")
  ) {
    throw new Error(
      "reply prefix must be a literal http/https prefix ending in / with no userinfo, query, or fragment",
    );
  }
  return value;
}

export function validateReplyConfiguration(
  replyURL: string | null,
  replyPrefixes: string[],
): void {
  const validated = replyPrefixes.map(validateReplyPrefix);
  if (replyURL && !validated.some((prefix) => replyURL.startsWith(prefix))) {
    throw new Error("default reply URL is outside the permitted prefixes");
  }
}
