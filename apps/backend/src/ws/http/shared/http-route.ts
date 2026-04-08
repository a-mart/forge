import type { IncomingMessage, ServerResponse } from "node:http";

export interface HttpRoute {
  readonly methods: string;
  matches: (pathname: string) => boolean;
  handle: (request: IncomingMessage, response: ServerResponse, requestUrl: URL) => Promise<void>;
}
