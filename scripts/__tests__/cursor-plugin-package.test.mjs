import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("plugins/frihet-erp/.cursor-plugin/plugin.json"));
const server = JSON.parse(read("plugins/frihet-erp/mcp.json")).mcpServers.frihet;
const packageVersion = JSON.parse(read("package.json")).version;
const properties = manifest.variables.properties;
const defaults = Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, schema.default]));
// Models the documented variable values for a source-process smoke only.
// This is not evidence that a Cursor/Grok host expanded an installed plugin.
const sourceEnvironment = (values) => ({
  PATH: process.env.PATH ?? "",
  ...Object.fromEntries(Object.entries(server.env).map(([name, value]) => [
    name, value.replace(/\$\{([^}]+)\}/gu, (_, variable) => values[variable]),
  ])),
});

test("Cursor repository manifest resolves a portable Frihet plugin with declared variables", () => {
  const marketplace = JSON.parse(read(".cursor-plugin/marketplace.json"));
  const entry = marketplace.plugins.find((candidate) => candidate.name === manifest.name);
  assert.equal(entry.source, "./plugins/frihet-erp");
  assert.equal(manifest.name, "frihet-erp");
  assert.equal(manifest.author.name, "Frihet");
  assert.equal(manifest.homepage, "https://www.frihet.io");
  assert.equal(manifest.repository, "https://github.com/Frihet-io/frihet-mcp");
  assert.equal(manifest.license, "MIT");
  assert.equal(read("plugins/frihet-erp/LICENSE"), read("LICENSE"));
  assert.equal(Object.hasOwn(manifest, "displayName"), false);
  assert.equal(manifest.variables.type, "object");
  const placeholders = [...JSON.stringify(server).matchAll(/\$\{([^}]+)\}/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(placeholders)].sort(), Object.keys(properties).sort());
  for (const name of placeholders) assert.equal(properties[name].type, "string");
  assert.deepEqual(manifest.variables.required, ["FRIHET_DEMO"]);
  assert.deepEqual(properties.FRIHET_DEMO.enum, ["0", "1"]);
  assert.equal(defaults.FRIHET_DEMO, "0");
  assert.equal(defaults.FRIHET_API_KEY, "");
  assert.equal(server.env.FRIHET_TOOL_MODE, "full");
  const skills = readdirSync(new URL("../../plugins/frihet-erp/skills/", import.meta.url));
  assert.deepEqual(skills.sort(), ["clientes", "cobros", "documentos", "frihet-mcp", "gastos", "operaciones", "revision-mensual", "tesoreria"]);
  assert.equal(read("plugins/frihet-erp/skills/cobros/SKILL.md"), read("skills/cobros/SKILL.md"));
});

test("plugin and standalone Cursor template pin the manifest version instead of latest", () => {
  assert.equal(manifest.version, packageVersion);
  const expectedArgs = ["-y", `@frihet/mcp-server@${packageVersion}`];
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, expectedArgs);
  const standalone = JSON.parse(read("marketplace/cursor/.cursor/mcp.json"));
  assert.deepEqual(Object.keys(standalone.mcpServers), ["frihet"]);
  assert.deepEqual(standalone.mcpServers.frihet.args, expectedArgs);
  assert.equal(standalone.mcpServers.frihet.type, "stdio");
});

test("source launch with the plugin's live defaults fails closed before a credentialed call", () => {
  const result = spawnSync(process.execPath, ["dist/index.js"], {
    cwd: root,
    env: sourceEnvironment(defaults),
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FRIHET_API_KEY_MISSING/u);
  assert.doesNotMatch(result.stderr, /DEMO MODE/u);
  assert.equal(result.stdout, "");
});

test("source launch with declared demo values serves fixtures over MCP without a key", { timeout: 30000 }, async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import=data:text/javascript,globalThis.fetch%3Dasync()%3D%3E%7Bthrow%20new%20Error('NETWORK_DISABLED_BY_PLUGIN_TEST')%7D", "dist/index.js"],
    cwd: root,
    env: sourceEnvironment({ ...defaults, FRIHET_DEMO: "1" }),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: "cursor-plugin-source-smoke", version: "1.0.0" });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, manifest.version);
  const catalogue = await client.listTools();
  assert.equal(catalogue.tools.length, 163);
  assert.ok(catalogue.tools.some((tool) => tool.name === "get_business_context"));
  const context = await client.callTool({ name: "get_business_context", arguments: {} });
  assert.notEqual(context.isError, true);
  assert.equal(context.structuredContent._demo, true);
  assert.match(stderr, /DEMO MODE/u);
  assert.doesNotMatch(stderr, /NETWORK_DISABLED_BY_PLUGIN_TEST/u);
});
