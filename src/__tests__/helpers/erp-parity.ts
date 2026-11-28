import type { TestContext } from "node:test";
import { createServer, type ServerResponse, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IFrihetClient } from "../../client-interface.js";
import { FrihetClient } from "../../client.js";
import { localMcpSurfaceComposition, registerMcpSurface, type McpSurfaceComposition } from "../../server-composition.js";

export const fixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(
  readFileSync(new URL(`../../../src/__tests__/fixtures/${name}.json`, import.meta.url), "utf8"),
) as T;

export interface WireRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: string;
}

export async function erpServer(
  t: TestContext,
  respond: (request: WireRequest, response: ServerResponse) => void,
) {
  const requests: WireRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = {
      method: req.method ?? "", url: new URL(req.url ?? "/", "http://localhost"),
      headers: req.headers, body: Buffer.concat(chunks).toString("utf8"),
    };
    requests.push(request);
    res.setHeader("Content-Type", "application/json");
    respond(request, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const { port } = server.address() as AddressInfo;
  const backend = new FrihetClient("fri_test_key", `http://127.0.0.1:${port}/v1`, { retryBudgetMs: 0 });
  return { backend, requests };
}

export async function mcpSurface(
  t: TestContext,
  backend: IFrihetClient,
  composition: McpSurfaceComposition = localMcpSurfaceComposition(false, false),
) {
  const server = new McpServer({ name: "erp-parity-test", version: "1.0.0" });
  registerMcpSurface(server, backend, composition);
  const client = new Client({ name: "erp-parity-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
