import type { Connector } from "transit-connector-kit";
import mattermost from "transit-connector-mattermost";
import gmail from "transit-connector-gmail";
import telegram from "transit-connector-telegram";
import kaneo from "transit-connector-kaneo";
import ingest from "./ingest";

export const CONNECTORS: Record<string, Connector> = {
  mattermost,
  gmail,
  telegram,
  kaneo,
  ingest,
};

export function connectorFor(name: string): Connector {
  const connector = CONNECTORS[name];
  if (!connector) throw new Error(`unknown connector: ${name}`);
  return connector;
}
