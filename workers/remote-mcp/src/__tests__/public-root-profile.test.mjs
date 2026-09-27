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

/** Every enclosing node, innermost first. Requires the source to have been
 * parsed with setParentNodes = true (see `parse` above). */
function ancestorsOf(node) {
  const out = [];
  for (let current = node.parent; current; current = current.parent) out.push(current);
  return out;
}

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

  // The condition text alone survives a mutant that changes the enclosing
  // "request.method === \"GET\"" guard to another method — the pathname/openai
  // check would still be found, but a real GET request would never reach it.
  const methodGuard = ancestorsOf(rootIntercept).find((node) =>
    ts.isIfStatement(node) && node.expression.getText(indexSource) === 'request.method === "GET"');
  assert.ok(
    methodGuard,
    'the reviewed-root interception must be nested inside a request.method === "GET" guard, or GET requests never reach it',
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
// auth-handler.ts's GET / is reached via OAuthProvider's default handler only
// when a request was never intercepted above. In production that means only
// the full host, but this handler does not merely assume that — it refuses
// explicitly on the reviewed profile, so a routing mistake upstream (e.g. a
// future shortcut that forwards a reviewed-host request here) fails closed
// instead of leaking the full catalogue.
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
assert.equal(rootHandlers.length, 1, "exactly one production GET / handler must be tested");
const [rootHandlerSource] = rootHandlers;

function evalRootHandler(openaiMode) {
  return vm.runInNewContext(`(${rootHandlerSource})(c)`, {
    c: {
      env: { FRIHET_OPENAI_MODE: openaiMode },
      json: (value, status = 200) => ({ body: value, status }),
    },
    resolveFrihetAccessProfile: (value) => {
      if (value === "true") return "openai";
      if (value === "false") return "full";
      throw new Error("FRIHET_OPENAI_MODE must be explicitly set to true or false");
    },
    MCP_SERVER_VERSION: "test-version",
    FULL_MCP_ORIGIN: "https://mcp.frihet.io",
    FULL_REMOTE_TOOL_COUNT: 166,
    FULL_TOOL_COUNT: 158,
    FISCAL_ALIAS_TOOL_COUNT: 5,
    GROUPED_META_TOOL_COUNT: 3,
    FULL_REMOTE_RESOURCE_COUNT: 7,
    FULL_REMOTE_PROMPT_COUNT: 10,
  }, { timeout: 1000 });
}

test("the full host's GET / advertises the full catalogue, never reviewed-host metadata", () => {
  const { body, status } = evalRootHandler("false");
  const root = JSON.parse(JSON.stringify(body));

  assert.equal(status, 200);
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

test("the reviewed profile is refused, not answered with the full descriptor", () => {
  const { body, status } = evalRootHandler("true");
  assert.equal(status, 404, "a reviewed-host request that reaches this handler must fail closed");
  const text = JSON.stringify(body ?? {});
  assert.equal(text.includes("mcp.frihet.io"), false, "must never leak the full host's endpoint");
  assert.equal(text.includes("openapi"), false, "must never leak the full REST/OpenAPI surface");
  assert.equal(Object.hasOwn(body ?? {}, "tools"), false);
});
