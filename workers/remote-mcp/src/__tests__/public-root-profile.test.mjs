import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Exercise the actual root handler without loading Cloudflare Durable Objects
// or opening a socket. Parsing the route avoids testing a copied implementation.
const source = ts.createSourceFile(
  "auth-handler.ts",
  readFileSync(new URL("../auth-handler.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const handlers = [];
for (const statement of source.statements) {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
  const call = statement.expression;
  if (call.expression.getText(source) === "app.get"
    && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === "/") {
    handlers.push(call.arguments[1].getText(source));
  }
}
assert.equal(handlers.length, 1, "exactly one production GET / handler must be tested");

function response(openai) {
  const body = vm.runInNewContext(`(${handlers[0]})(c)`, {
    c: { env: { FRIHET_OPENAI_MODE: String(openai) }, json: value => value },
    resolveFrihetAccessProfile: value => value === "true" ? "openai" : "full",
    MCP_SERVER_VERSION: "test-version",
    OPENAI_ALLOWED_TOOL_COUNT: 33,
    FULL_REMOTE_TOOL_COUNT: 166,
    FULL_TOOL_COUNT: 158,
    FISCAL_ALIAS_TOOL_COUNT: 5,
    GROUPED_META_TOOL_COUNT: 3,
    FULL_REMOTE_RESOURCE_COUNT: 7,
    FULL_REMOTE_PROMPT_COUNT: 10,
  }, { timeout: 1000 });
  return JSON.parse(JSON.stringify(body));
}

test("reviewed root stays on the reviewed host and advertises no REST catalogue", () => {
  const body = response(true);
  assert.equal(body.mcp, "https://openai-mcp.frihet.io/mcp");
  assert.equal(body.auth.authorization_server, "https://openai-mcp.frihet.io/.well-known/oauth-authorization-server");
  assert.equal(body.docs, "https://openai-mcp.frihet.io/support");
  assert.equal(body.privacy, "https://openai-mcp.frihet.io/privacy");
  assert.equal(Object.hasOwn(body, "openapi"), false);
  assert.equal(JSON.stringify(body).includes("https://api.frihet.io"), false);
  assert.equal(body.tools, 33);
  assert.equal(body.discoveryNames, 0);
  assert.equal(body.resources, 0);
  assert.equal(body.prompts, 0);
});

test("full root preserves its independently advertised REST and MCP surfaces", () => {
  const body = response(false);
  assert.equal(body.mcp, "https://mcp.frihet.io/mcp");
  assert.equal(body.docs, "https://docs.frihet.io/desarrolladores/mcp-server");
  assert.equal(body.openapi, "https://api.frihet.io/openapi.yaml");
  assert.equal(body.tools, 166);
  assert.equal(body.catalogueOperations, 158);
  assert.equal(body.aliasNames, 5);
  assert.equal(body.discoveryNames, 3);
  assert.equal(body.resources, 7);
  assert.equal(body.prompts, 10);
});
