/**
 * Server card (SEP-1649 `.well-known/mcp.json`) shape regression.
 *
 * The card is what registries/clients read to discover the server WITHOUT
 * initializing, so its identity, transport, and auth fields must stay stable
 * and single-sourced from server-meta (version from package.json).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServerCard, MCP_PROTOCOL_VERSION } from "../server-card.ts";

const VERSION = "1.16.0";
const FULL_TOOL_COUNT = 157;

const card = buildServerCard({
  name: "io.frihet/erp",
  title: "Frihet ERP",
  version: VERSION,
  description: "AI-native ERP MCP server.",
  host: "https://mcp.frihet.io",
  toolCount: FULL_TOOL_COUNT,
  resourceCount: 11,
  promptCount: 10,
});

test("card carries reverse-DNS identity and caller-supplied version", () => {
  const info = card.serverInfo as Record<string, unknown>;
  assert.equal(info.name, "io.frihet/erp");
  assert.equal(info.title, "Frihet ERP");
  assert.equal(info.version, VERSION);
});

test("card advertises the streamable-http /mcp endpoint on the given host", () => {
  const transport = card.transport as Record<string, unknown>;
  assert.equal(transport.type, "streamable-http");
  assert.equal(transport.endpoint, "https://mcp.frihet.io/mcp");
});

test("card declares oauth2 + bearer auth against the host's authorization server", () => {
  const auth = card.authentication as Record<string, unknown>;
  assert.equal(auth.required, true);
  assert.deepEqual(auth.schemes, ["oauth2", "bearer"]);
  assert.equal(
    auth.authorizationServer,
    "https://mcp.frihet.io/.well-known/oauth-authorization-server",
  );
});

test("card pins schema, protocol version, docs, and tool count", () => {
  assert.equal(card.$schema, "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json");
  assert.equal(card.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(card.documentationUrl, "https://docs.frihet.io/desarrolladores/mcp-server");
  assert.equal(card.tools_count, FULL_TOOL_COUNT);
});

test("host is respected so the OpenAI-scoped card self-references its own origin", () => {
  const scoped = buildServerCard({
    name: "io.frihet/erp",
    title: "Frihet ERP MCP Connector",
    version: VERSION,
    description: "Scoped.",
    host: "https://openai-mcp.frihet.io",
    toolCount: 53,
    resourceCount: 0,
    promptCount: 0,
  });
  const transport = scoped.transport as Record<string, unknown>;
  const auth = scoped.authentication as Record<string, unknown>;
  assert.equal(transport.endpoint, "https://openai-mcp.frihet.io/mcp");
  assert.equal(
    auth.authorizationServer,
    "https://openai-mcp.frihet.io/.well-known/oauth-authorization-server",
  );
  assert.equal(scoped.tools_count, 53);
});
