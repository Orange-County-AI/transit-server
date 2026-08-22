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

export function formatRoomAddress(room: string): string {
  validateName(room);
  return `#${room}`;
}

export function parseAddress(value: string): TransitAddress {
  if (value.startsWith("#")) {
    const room = value.slice(1);
    validateName(room);
    return { kind: "room", room, address: `#${room}` };
  }

  let organization: string | undefined;
  let agentValue = value;
  const slash = value.indexOf("/");
  if (slash >= 0) {
    if (slash === 0 || slash !== value.lastIndexOf("/") || slash === value.length - 1) {
      throw new AddressError(
        "address must be name@host, organization/name@host, or #room",
        "invalid_address",
      );
    }
    organization = value.slice(0, slash);
    validateOrganizationSlug(organization);
    agentValue = value.slice(slash + 1);
  }

  const at = agentValue.indexOf("@");
  if (
    at <= 0 ||
    at !== agentValue.lastIndexOf("@") ||
    at === agentValue.length - 1
  ) {
    throw new AddressError(
      "address must be name@host, organization/name@host, or #room",
      "invalid_address",
    );
  }

  const name = agentValue.slice(0, at);
  const host = agentValue.slice(at + 1);
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
