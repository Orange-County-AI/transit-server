export const TRANSIT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const TRANSIT_HOST_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const TRANSIT_ORGANIZATION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESERVED_NAMES: Record<string, true> = { transit: true, operator: true };
export const OPERATOR_ADDRESS = "operator@transit";

export class AddressError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_name" | "invalid_address" | "reserved_name",
  ) {
    super(message);
    this.name = "AddressError";
  }
}

export type AgentAddress = {
  kind: "agent";
  name: string;
  host: string;
  organization?: string;
  address: string;
};

export type RoomAddress = {
  kind: "room";
  room: string;
  /**
   * Owning organization slug, present only on a qualified `organization/#room`
   * address. Absent means "a room in the caller's own organization" — the
   * original grammar, unchanged.
   */
  organization?: string;
  address: string;
};

export type TransitAddress = AgentAddress | RoomAddress;

export function validateName(value: string): void {
  if (!TRANSIT_NAME_PATTERN.test(value)) {
    throw new AddressError(
      `name must match ${TRANSIT_NAME_PATTERN.source}`,
      "invalid_name",
    );
  }
  if (RESERVED_NAMES[value]) {
    throw new AddressError(`${value} is reserved`, "reserved_name");
  }
}

export function validateHost(value: string): void {
  if (!TRANSIT_HOST_PATTERN.test(value)) {
    throw new AddressError(
      `host must match ${TRANSIT_HOST_PATTERN.source}`,
      "invalid_name",
    );
  }
  if (RESERVED_NAMES[value]) {
    throw new AddressError(`${value} is reserved`, "reserved_name");
  }
}
export function validateOrganizationSlug(value: string): void {
  if (
    value.length < 2 ||
    value.length > 128 ||
    !TRANSIT_ORGANIZATION_PATTERN.test(value)
  ) {
    throw new AddressError(
      `organization slug must match ${TRANSIT_ORGANIZATION_PATTERN.source}`,
      "invalid_address",
    );
  }
}


export function formatAgentAddress(
  name: string,
  host: string,
  organization?: string,
): string {
  validateName(name);
  validateHost(host);
  if (organization) validateOrganizationSlug(organization);
  const local = `${name}@${host}`;
  return organization ? `${organization}/${local}` : local;
}

export function formatRoomAddress(room: string, organization?: string): string {
  validateName(room);
  if (organization) validateOrganizationSlug(organization);
  return organization ? `${organization}/#${room}` : `#${room}`;
}

const ADDRESS_GRAMMAR =
  "address must be name@host, organization/name@host, #room, or organization/#room";

/**
 * Lenient room-target parser for tool parameters, which have always accepted a
 * bare room name as well as `#room`. Accepts `room`, `#room`, `org/room`, and
 * `org/#room`; rejects everything an address parse would reject.
 */
export function parseRoomTarget(value: string): RoomAddress {
  const slash = value.indexOf("/");
  if (slash < 0) {
    return parseAddress(value.startsWith("#") ? value : `#${value}`) as RoomAddress;
  }
  const local = value.slice(slash + 1);
  const qualified = `${value.slice(0, slash)}/${local.startsWith("#") ? local : `#${local}`}`;
  const parsed = parseAddress(qualified);
  if (parsed.kind !== "room") throw new AddressError(ADDRESS_GRAMMAR, "invalid_address");
  return parsed;
}

export function parseAddress(value: string): TransitAddress {
  let organization: string | undefined;
  let local = value;
  const slash = value.indexOf("/");
  if (slash >= 0) {
    if (slash === 0 || slash !== value.lastIndexOf("/") || slash === value.length - 1) {
      throw new AddressError(ADDRESS_GRAMMAR, "invalid_address");
    }
    organization = value.slice(0, slash);
    validateOrganizationSlug(organization);
    local = value.slice(slash + 1);
  }

  if (local.startsWith("#")) {
    const room = local.slice(1);
    validateName(room);
    return {
      kind: "room",
      room,
      ...(organization ? { organization } : {}),
      address: formatRoomAddress(room, organization),
    };
  }

  const at = local.indexOf("@");
  if (at <= 0 || at !== local.lastIndexOf("@") || at === local.length - 1) {
    throw new AddressError(ADDRESS_GRAMMAR, "invalid_address");
  }

  const name = local.slice(0, at);
  const host = local.slice(at + 1);
  validateName(name);
  validateHost(host);
  return {
    kind: "agent",
    name,
    host,
    ...(organization ? { organization } : {}),
    address: formatAgentAddress(name, host, organization),
  };
}
