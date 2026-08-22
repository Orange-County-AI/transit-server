export type ConnectorCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

type Handler = {
  method: string;
  matches: (url: URL) => boolean;
  respond: (call: ConnectorCall) => Response | Promise<Response>;
};

const handlers: Handler[] = [];
export const connectorCalls: ConnectorCall[] = [];

export function onConnectorFetch(
  method: string,
  matches: (url: URL) => boolean,
  respond: (call: ConnectorCall) => Response | Promise<Response>,
): () => void {
  const handler = { method, matches, respond };
  handlers.unshift(handler);
  return () => {
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  };
}

export function resetConnectorMock(): void {
  handlers.length = 0;
  connectorCalls.length = 0;
}

export function installConnectorMock(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const call: ConnectorCall = {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    };
    connectorCalls.push(call);
    const handler = handlers.find(
      (candidate) =>
        candidate.method === request.method && candidate.matches(url),
    );
    if (!handler) {
      throw new Error(
        `Unexpected outbound fetch in tests: ${request.method} ${request.url}`,
      );
    }
    return handler.respond(call);
  }) as typeof realFetch;
}
