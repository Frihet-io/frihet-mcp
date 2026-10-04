import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const rootUrl = new URL("../../", import.meta.url);
const root = fileURLToPath(rootUrl);
const read = (path) => JSON.parse(readFileSync(new URL(path, rootUrl), "utf8"));
const plugin = read("marketplace/openai/plugin.json");
const mcp = read("marketplace/openai/mcp.json");
const submission = read("marketplace/openai/chatgpt-app-submission.json");
const descriptor = read("src/__tests__/fixtures/openai-review-descriptor.snapshot.json");
const openai = plugin.extensions["com.openai"];

function textWithin(value, limit) {
  assert.equal(typeof value, "string");
  assert.ok(value.trim().length > 0 && value.length <= limit);
  assert.doesNotMatch(value, /[\u0000-\u0008\u000b-\u001f\u007f\t]/u);
}

test("portable listing preserves identity, reviewed scope and public submission limits", () => {
  assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(plugin.name, "app-69b6147ce32c81918680c89bfa7c9b36");
  assert.equal(plugin.version, "1.0.1");
  assert.equal(plugin.author.name, "Frihet");
  assert.deepEqual(Object.keys(openai).sort(), ["interface", "publication", "review"]);
  const listing = openai.interface;
  for (const [key, limit] of Object.entries({ displayName: 30, shortDescription: 30, longDescription: 4000, developerName: 80 })) {
    textWithin(listing[key], limit);
  }
  assert.equal(listing.category, "Business & Operations");
  assert.equal(listing.developerName, "Frihet");
  assert.match(listing.longDescription, /VICTOR BERTHELIUS PATO/);
  assert.equal(listing.longDescription, submission.app_info.description);
  for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    textWithin(listing[key], 1024);
    const url = new URL(listing[key]);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username + url.password, "");
  }
  assert.equal(listing.defaultPrompt.length, 3);
  assert.equal(new Set(listing.defaultPrompt).size, 3);
  for (const prompt of listing.defaultPrompt) {
    textWithin(prompt, 128);
    assert.doesNotMatch(prompt, /@/);
  }
  assert.ok(listing.capabilities.length <= 20);
  listing.capabilities.forEach((value) => textWithin(value, 120));
  assert.deepEqual(openai.publication.countries, ["ES"]);
  const spanish = openai.publication.translations["es-ES"];
  textWithin(spanish.subtitle, 30);
  textWithin(spanish.description, 4000);
  assert.match(spanish.description, /VICTOR BERTHELIUS PATO/);
  assert.deepEqual(mcp, {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { frihet: { type: "streamable-http", url: "https://openai-mcp.frihet.io/mcp" } },
  });
  assert.equal(mcp.mcpServers.frihet.url, descriptor.oauth.protectedResourceMcp.resource);
  assert.deepEqual(Object.keys(openai.review), ["test_cases"], "video remains absent until a real recording exists");
  for (const [kind, source, count] of [["positive", submission.test_cases, 5], ["negative", submission.negative_test_cases, 3]]) {
    const cases = openai.review.test_cases[kind];
    assert.equal(cases.length, count);
    cases.forEach((entry, index) => {
      textWithin(entry.description, 4000);
      assert.equal(entry.prompt, source[index].user_prompt);
      assert.equal(entry.expected_behavior, source[index].expected_output);
      assert.equal(entry.tools_triggered ?? null, source[index].tools_triggered);
      for (const name of (entry.tools_triggered ?? "").split(",").filter(Boolean)) {
        assert.ok(descriptor.tools.some((tool) => tool.name === name.trim()));
      }
    });
  }
  assert.doesNotMatch(JSON.stringify({ plugin, mcp }), /"(?:test_credentials|reviewer_instructions|headers|env|apps|hooks)"/);
});

test("ZIP is reproducible, contains only reviewed files and leaves npm built artifacts clean", () => {
  const archive = () => execFileSync("python3", ["scripts/package-openai-plugin.py"], { cwd: root, encoding: "utf8" }).trim();
  const archivePath = archive();
  assert.equal(archivePath, fileURLToPath(new URL(`marketplace/openai/dist/${plugin.name}-${plugin.version}.zip`, rootUrl)));
  const first = readFileSync(archivePath);
  assert.deepEqual(readFileSync(archive()), first);
  execFileSync("python3", ["-c", `
import json, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2]) as bundle:
    expected = {'plugin.json', 'mcp.json', 'assets/frihet-composer.png', 'assets/frihet-composer-dark.png', 'assets/frihet-directory-dark.png'}
    assert set(bundle.namelist()) == expected
    assert bundle.testzip() is None
    for entry in bundle.infolist():
        assert entry.date_time == (1980, 1, 1, 0, 0, 0)
        assert entry.external_attr >> 16 == 0o100644
        name = pathlib.Path(entry.filename).name
        data = bundle.read(entry)
        assert data == (root / 'marketplace/openai' / name).read_bytes()
        if name.endswith('.png'):
            assert data[:8] == b'\\x89PNG\\r\\n\\x1a\\n'
            assert int.from_bytes(data[16:20], 'big') == 512
            assert int.from_bytes(data[20:24], 'big') == 512
    manifest = json.loads(bundle.read('plugin.json'))['extensions']['com.openai']['interface']
    for key in ('logo', 'logoDark', 'composerIcon', 'composerIconDark'):
        assert manifest[key].removeprefix('./') in expected
`, root, archivePath], { cwd: root, stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/check-no-analytics-emitters.mjs", "--built"], { cwd: root, stdio: "pipe" });
});
