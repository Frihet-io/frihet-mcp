import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// index.ts cannot be imported here — it pulls Cloudflare/OAuth/DO bindings the
// node test runner can't resolve (see discovery-legal-truth.test.mjs for the
// same constraint), so this walks the real AST instead of a copied
// implementation.
function parse(fileName, source) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  // forEachChild stops visiting siblings as soon as the callback returns a
  // truthy value — the recursive call must not let its return value (the
  // shared, always-truthy array) leak out, or only the first child at each
  // level ever gets visited.
  ts.forEachChild(node, (child) => { findAll(child, predicate, out); });
  return out;
}

const indexSource = parse("index.ts", readFileSync(new URL("../index.ts", import.meta.url), "utf8"));

test("the reviewed host's GET / is intercepted before OAuthProvider and serves the same descriptor as /.well-known/mcp", () => {
  const rootIntercepts = findAll(indexSource, (node) =>
    ts.isIfStatement(node) && node.expression.getText(indexSource) === 'pathname === "/" && openai');
  assert.equal(rootIntercepts.length, 1, 'index.ts must have exactly one "GET / for the reviewed host" branch');
  const [rootIntercept] = rootIntercepts;
  assert.match(
    rootIntercept.thenStatement.getText(indexSource),
    /new Response\(WELL_KNOWN_MCP_OPENAI/,
    "the reviewed root must serve the same constant as /.well-known/mcp and /mcp.json, not a hand-copied shape",
  );

  const providerDispatches = findAll(indexSource, (node) =>
    ts.isCallExpression(node) && node.expression.getText(indexSource) === "selectedProvider.fetch");
  assert.equal(providerDispatches.length, 1, "index.ts must dispatch exactly once to the selected OAuthProvider");
  assert.ok(
    rootIntercept.getStart() < providerDispatches[0].getStart(),
    "the reviewed-root interception must run before the request reaches OAuthProvider — otherwise it is unreachable dead code",
  );
});

test("OPENAI_MCP_DESCRIPTOR has the shape the public preflight checker actually validates", () => {
  const descriptorDecls = findAll(indexSource, (node) =>
    ts.isVariableDeclaration(node)
    && node.name.getText(indexSource) === "OPENAI_MCP_DESCRIPTOR"
    && node.initializer
    && ts.isObjectLiteralExpression(node.initializer));
  assert.equal(descriptorDecls.length, 1, "index.ts must declare OPENAI_MCP_DESCRIPTOR as an object literal");
  const keys = descriptorDecls[0].initializer.properties.map((property) => property.name.getText(indexSource));

  for (const key of [
    "endpoint", "tools_count", "reviewed_business_tools_count", "discovery_meta_tools_count",
    "resources_count", "prompts_count", "docs", "privacy", "auth",
  ]) assert.ok(keys.includes(key), `OPENAI_MCP_DESCRIPTOR must declare "${key}"`);

  // The historical full-root shape (auth-handler.ts, before this fix) used a
  // different vocabulary for the same concepts. A regression back to that
  // vocabulary here is exactly what made the public preflight checker
  // permanently fail against a correct deploy.
  for (const key of ["tools", "reviewedBusinessOperations", "discoveryNames", "resources", "prompts", "mcp"]) {
    assert.ok(!keys.includes(key), `OPENAI_MCP_DESCRIPTOR must not carry the historical full-root key "${key}"`);
  }
});

// --------------------------------------------------------------------------
// The full host's GET / (auth-handler.ts, reached via OAuthProvider's default
// handler only when the request was never intercepted above, i.e. only on the
// full host) has no reviewed-host branch left — the reviewed host never
// reaches this file.
// --------------------------------------------------------------------------
const authHandlerSource = parse("auth-handler.ts", readFileSync(new URL("../auth-handler.ts", import.meta.url), "utf8"));
const rootHandlers = [];
for (const statement of authHandlerSource.statements) {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
  const call = statement.expression;
  if (call.expression.getText(authHandlerSource) === "app.get"
    && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === "/") {
    rootHandlers.push(call.arguments[1].getText(authHandlerSource));
  }
}

test("the full host's GET / handler in auth-handler.ts has exactly one definition and no reviewed-host branch", () => {
  assert.equal(rootHandlers.length, 1, "exactly one production GET / handler must be tested");
  assert.doesNotMatch(
    rootHandlers[0],
    /openai/i,
    "auth-handler.ts's GET / only ever runs on the full host (see index.ts) and must not branch on the reviewed profile",
  );
});

test("the full host's GET / advertises the full catalogue, never reviewed-host metadata", () => {
  const body = vm.runInNewContext(`(${rootHandlers[0]})(c)`, {
    c: { json: (value) => value },
    MCP_SERVER_VERSION: "test-version",
    FULL_MCP_ORIGIN: "https://mcp.frihet.io",
    FULL_REMOTE_TOOL_COUNT: 166,
    FULL_TOOL_COUNT: 158,
    FISCAL_ALIAS_TOOL_COUNT: 5,
    GROUPED_META_TOOL_COUNT: 3,
    FULL_REMOTE_RESOURCE_COUNT: 7,
    FULL_REMOTE_PROMPT_COUNT: 10,
  }, { timeout: 1000 });
  const root = JSON.parse(JSON.stringify(body));

  assert.equal(root.mcp, "https://mcp.frihet.io/mcp");
  assert.equal(root.docs, "https://docs.frihet.io/desarrolladores/mcp-server");
  assert.equal(root.openapi, "https://api.frihet.io/openapi.yaml");
  assert.equal(root.tools, 166);
  assert.equal(root.catalogueOperations, 158);
  assert.equal(root.aliasNames, 5);
  assert.equal(root.discoveryNames, 3);
  assert.equal(root.resources, 7);
  assert.equal(root.prompts, 10);
  assert.equal(Object.hasOwn(root, "privacy"), false, "the full host must not claim reviewed-host privacy metadata");
  assert.equal(Object.hasOwn(root, "reviewedBusinessOperations"), false, "the full host must not claim reviewed-host tool counts");
});
