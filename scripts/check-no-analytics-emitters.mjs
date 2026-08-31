#!/usr/bin/env node

/**
 * Fail-closed analytics-emitter gate.
 *
 * Frihet MCP may disclose downstream ERP analytics in prose. It must not add an
 * analytics transport of its own without a reviewed contract. This analyzer
 * therefore ignores ordinary prose while rejecting executable SDK/config/
 * endpoint/emitter shapes and any outbound network sink outside the exact
 * reviewed inventory below.
 */

import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const SCAN_ROOTS = Object.freeze(["src", "workers"]);
export const EXTRA_RUNTIME_FILES = Object.freeze(["scripts/postinstall.js"]);
export const FORBIDDEN_REPOSITORY_FILES = Object.freeze([
  ".npmrc",
  "npm-shrinkwrap.json",
  "workers/remote-mcp/.npmrc",
  "workers/remote-mcp/npm-shrinkwrap.json",
  "workers/api-proxy/wrangler.json",
  "workers/api-proxy/wrangler.jsonc",
  "workers/remote-mcp/wrangler.json",
  "workers/remote-mcp/wrangler.jsonc",
]);
export const APPROVED_LIFECYCLE_SCRIPTS = Object.freeze({
  postinstall: "node scripts/postinstall.js || true",
});
export const APPROVED_PACKAGE_SCRIPT_HASHES = Object.freeze({
  "package.json": "083b30d76162ba2e9b3e50a25ebe8c89fb7a207e188171ac38aff9ef09cfae73",
  "workers/remote-mcp/package.json": "c7025291c46b023fac162d1a0e0a010d1173bf7bc5d218c6faaab515aba97c6b",
});
export const APPROVED_WORKER_MAINS = Object.freeze({
  "workers/api-proxy/wrangler.toml": "worker.js",
  "workers/remote-mcp/wrangler.toml": "src/index.ts",
});
export const APPROVED_PLATFORM_TELEMETRY = Object.freeze({
  "workers/remote-mcp/wrangler.toml|cloudflare-observability": "enabled",
});
export const APPROVED_DIST_IMPORTS = Object.freeze({
  "workers/remote-mcp/scripts/capture-openai-review.mjs": Object.freeze([
    "../../../dist/openai-review-contract.js",
  ]),
});
export const APPROVED_PACKAGE_RUNTIME_METADATA = Object.freeze({
  "package.json": {
    main: "./dist/index.js",
    type: "module",
    bin: { "frihet-mcp": "./dist/index.js" },
    browser: null,
    bundleDependencies: null,
    bundledDependencies: null,
    exports: null,
    files: [
      "dist",
      "!dist/__tests__",
      "!dist/**/*.map",
      "scripts/postinstall.js",
      "assets/banner.svg",
      "assets/banner-light.svg",
      "assets/logo-400.png",
      "docs/agent-onboarding.json",
      "README.md",
      "LICENSE",
    ],
    imports: null,
    module: null,
    workspaces: null,
  },
  "workers/remote-mcp/package.json": {
    main: null,
    type: "module",
    bin: null,
    browser: null,
    bundleDependencies: null,
    bundledDependencies: null,
    exports: null,
    files: null,
    imports: null,
    module: null,
    workspaces: null,
  },
});
export const APPROVED_PACKAGE_DEPENDENCIES = Object.freeze({
  "package.json": {
    dependencies: { "@modelcontextprotocol/sdk": "^1.27.0" },
    devDependencies: { "@types/node": "^22.0.0", ajv: "8.18.0", typescript: "^5.7.0", zod: "^3.25.1" },
    optionalDependencies: {},
    overrides: { hono: "~4.12.34" },
    peerDependencies: { zod: ">=3.25.1" },
    resolutions: {},
  },
  "workers/remote-mcp/package.json": {
    dependencies: {
      "@cloudflare/workers-oauth-provider": "0.3.0",
      "@modelcontextprotocol/sdk": "^1.30.0",
      agents: "0.7.5",
      "firebase-auth-cloudflare-workers": "^2.0.6",
      hono: "~4.12.34",
      zod: "^3.25.0",
    },
    devDependencies: {
      "@cloudflare/workers-types": "^4.20250306.0",
      typescript: "^5.8.0",
      wrangler: "^4.67.0",
    },
    optionalDependencies: {},
    overrides: {
      "@modelcontextprotocol/sdk": { "@hono/node-server": "2.0.12", hono: "~4.12.34" },
      agents: { "@modelcontextprotocol/sdk": "1.30.0" },
      nanoid: "5.1.16",
    },
    peerDependencies: {},
    resolutions: {},
  },
});
export const EXCLUDED_DIRECTORIES = Object.freeze([
  ".git",
  ".wrangler",
  "__tests__",
  "dist",
  "node_modules",
]);
export const CODE_EXTENSIONS = Object.freeze([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

export const ANALYTICS_MODULE_PATTERNS = Object.freeze([
  /^@posthog\//i,
  /^posthog(?:-js|-node|-react-native)?$/i,
  /^@segment\/analytics-(?:browser|next|node)$/i,
  /^analytics-(?:browser|node)$/i,
  /^@amplitude\/analytics-(?:browser|node)$/i,
  /^mixpanel(?:-browser)?$/i,
  /^plausible-tracker$/i,
  /^@rudderstack\//i,
  /^rudder-sdk-js$/i,
  /^heap-js$/i,
  /^@vercel\/analytics(?:\/.*)?$/i,
  /^react-ga4$/i,
  /^@google-analytics\/data$/i,
  /^@opentelemetry\/exporter-.*otlp/i,
  /^@opentelemetry\/exporter-(?:logs|metrics|trace)/i,
]);

export const EMITTER_METHODS = Object.freeze([
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

/**
 * Stable fingerprints use path + enclosing function + callee + target source.
 * Counts make duplicated sinks explicit without depending on line numbers.
 */
export const APPROVED_NETWORK_SINKS = Object.freeze({
  "src/client.ts|request|fetch|url.toString()": 1,
  "src/client.ts|fetchRaw|fetch|url.toString()": 1,
  "src/observability.ts|sendBatch|fetch|`${config.baseUrl}/api/public/ingestion`": 1,
  "workers/api-proxy/worker.js|fetch|fetch|upstream.toString()": 2,
  "workers/remote-mcp/src/index.ts|fetch|env.ASSETS.fetch|assetReq": 2,
  "workers/remote-mcp/src/index.ts|fetch|fetch|UPSTREAM_HEALTH": 1,
  "workers/remote-mcp/src/index.ts|fetch|mcpApiHandler.fetch|request": 1,
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
  "workers/remote-mcp/src/oauth-token-family.ts|isOAuthAccessTokenFamilyActive|(awaittokenFamilyStub(namespace,credential.userId,credential.grantId,)).fetch|`${INTERNAL_ORIGIN}/token-family/status`": 1,
  "workers/remote-mcp/src/oauth-token-family.ts|revokeOAuthTokenFamily|(awaittokenFamilyStub(namespace,userId,grantId)).fetch|`${INTERNAL_ORIGIN}/token-family/revoke`": 1,
  "workers/remote-mcp/src/login-page.ts#inline-script|signIn|fetch|\"/callback\"": 1,
  "workers/remote-mcp/src/login-page.ts#inline-script|signIn|window.location.href|data.redirectTo": 1,
  "workers/remote-mcp/src/login-page.ts#inline-script|signInWithEmail|fetch|\"/callback\"": 1,
  "workers/remote-mcp/src/login-page.ts#inline-script|signInWithEmail|window.location.href|data.redirectTo": 1,
});
export const APPROVED_BUILT_NETWORK_SINKS = Object.freeze({
  "dist/client.js|request|fetch|url.toString()": 1,
  "dist/client.js|fetchRaw|fetch|url.toString()": 1,
  "dist/observability.js|sendBatch|fetch|`${config.baseUrl}/api/public/ingestion`": 1,
});

export const APPROVED_EMBEDDED_RESOURCES = Object.freeze({
  "workers/remote-mcp/src/login-page.ts|script|https://www.gstatic.com/firebasejs/11.0.0/firebase-app-compat.js": 1,
  "workers/remote-mcp/src/login-page.ts|script|https://www.gstatic.com/firebasejs/11.0.0/firebase-auth-compat.js": 1,
});

/**
 * Static authorities referenced through identifiers do not appear literally in
 * sink fingerprints. Pin them separately so changing an approved destination
 * cannot masquerade as an unchanged `fetch(url.toString())` call.
 */
export const APPROVED_STATIC_BINDINGS = Object.freeze({
  "src/client.ts|BASE_URL": "https://api.frihet.io/v1",
  "src/client.ts|OAUTH_CLOUD_FUNCTION_BASE_URL": "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api/v1",
  "src/observability.ts|CANONICAL_LANGFUSE_ORIGIN": "https://langfuse.frihet.io",
  "workers/api-proxy/worker.js|DEFAULT_UPSTREAM": "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api",
  "workers/remote-mcp/src/index.ts|UPSTREAM_HEALTH": "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/health",
  "workers/remote-mcp/src/api-url.ts|DEFAULT_API_BASE": "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api",
  "workers/remote-mcp/src/api-url.ts|TRUSTED_CLOUD_FUNCTION_HOST": "europe-west1-gen-lang-client-0335716041.cloudfunctions.net",
  "workers/remote-mcp/src/oauth-provisioning.ts|FRIHET_OAUTH_API_KEY_URL": "https://api.frihet.io/oauth/api-key",
  "workers/remote-mcp/src/oauth-provisioning.ts|CLOUD_FUNCTION_OAUTH_API_KEY_URL": "https://europe-west1-gen-lang-client-0335716041.cloudfunctions.net/publicApi/api/oauth/api-key",
  "workers/remote-mcp/src/oauth-state-store.ts|INTERNAL_ORIGIN": "https://oauth-state.internal",
  "workers/remote-mcp/src/oauth-token-family.ts|INTERNAL_ORIGIN": "https://oauth-state.internal",
});

/**
 * Freeze every complete source file that owns an approved sink (CRLF normalized
 * only). This covers binding provenance, relative-URL base semantics, payload
 * minimization, and authority validation. A callsite-only fingerprint can be
 * reproduced after shadowing `fetch`, so partial function hashes are not enough.
 */
export const APPROVED_SOURCE_FILE_HASHES = Object.freeze({
  "src/client.ts": "f20811cd41af15fec0af952a89a8a0df8a3630a12863ac63740fef299efd9f41",
  "src/observability.ts": "d0bd50c57843f59d0ab61b18b59c1e2ccfcc9dcb83ab76a00a34882d6d1d7cd6",
  "src/openai-review-oauth.ts": "388035b1b9952b5c1f0ecc82dcac962a93320b1076dc23d3e4a155dbf9bf263f",
  "workers/api-proxy/worker.js": "1838e99f60d15c13ffa1fbd6dc3a87ae827c86c61154b508f84377a601c75a54",
  "workers/remote-mcp/src/api-url.ts": "6603350d3dde02e0a8139f216320a055df79f1bbba45ff2e1bf2fe7f40f32f23",
  "workers/remote-mcp/src/auth-handler.ts": "7de5521aae87c2785fabf4703a37a3ecc803bad5bdb6913aa1504d53f4c6b6d1",
  "workers/remote-mcp/src/client.ts": "9b80ffc8c0f3fbef3d0a39d490f5a704ad4c1d054f08b53665dc28928afc2562",
  "workers/remote-mcp/src/index.ts": "a63033e9b79621f6758b7732fda0c88f13e8d229acb3a77f406295ef5faccd52",
  "workers/remote-mcp/src/login-page.ts": "1c4d6dcacbbcdc47db152242a4ca4adfb83b4f0229903e0550c63b973ab00ff5",
  "workers/remote-mcp/src/mcp-session-binding.ts": "cf792a5af0bf827b603e55fd77bcf9ae7e6facff4e7b2346b12165eef91b9ca5",
  "workers/remote-mcp/src/oauth-provisioning.ts": "d396b7442539786ee50ed6704a585fc24e44ef21d3e8420b50f08c1376326f90",
  "workers/remote-mcp/src/oauth-state-store.ts": "9785c628b2a01d80c06267a0c39beb93f9d9b7a11b26369d48aa2cc705bf7906",
  "workers/remote-mcp/src/oauth-token-family.ts": "fc0cb5c82b0d698139a0caf3dfae34d267e7366b6d073b4d1b901c8267af0eb6",
});
export const APPROVED_LOCKFILE_HASHES = Object.freeze({
  "package-lock.json": "ebf5ce3c3b9207fb07cfc2856c1ca3d3232e154133406435511fe99f08e6ae18",
  "workers/remote-mcp/package-lock.json": "9bd3aaa0bce155f446ef4f8c8fa792ba2a0871a4cb1f7468a4993c784c412191",
});
export const APPROVED_CONFIG_FILE_HASHES = Object.freeze({
  "workers/api-proxy/wrangler.toml": "ad6b87b998712fde47e0cbf97225c17e8cbfd078c688cb50377263a844fee8d2",
  "workers/remote-mcp/wrangler.toml": "c04ee0033b2d0c53cebfd562ccc3da27810bd1ef5b49e52beeb5d50b218100e5",
});
export const APPROVED_PUBLISHED_FILE_HASHES = Object.freeze({
  "assets/banner.svg": "2b32a68014580c334f8b180d8812d842c744a9a59bd2298a586bb95bd6179ebc",
  "assets/banner-light.svg": "4e9a087513a09a507b37578d80ef967f533b924a21dd39b14f4ec674f9d7a5b6",
  "assets/logo-400.png": "5d9da4692a5f34cef61c59a40521a10c9bbe5d70a39e67f34dd49ec05b2da2dd",
  "docs/agent-onboarding.json": "2dd391f0c3a507b001490355e7460712fe2d19d7a210c8b37804a1fa0234aea7",
  "README.md": "8fb65836483467e58fd07536d9b3b131d0f792e5d2d668b8b33e991dcaa2760c",
  "LICENSE": "4114205a864bbaf10b8c6fe8659cb7504562447c47c500fe4d0032dcf3aa2c97",
});
export const APPROVED_OPERATIONAL_FILE_HASHES = Object.freeze({
  ".github/workflows/ci.yml": "afb5a58808a20cb512a071210c38f02f551251a9b35297b6540a5a966440978d",
  "scripts/__tests__/conformance-phase0.test.mjs": "8d297ffab31b3420fbc00d2386f6f090088c958d08e4d7d7973342e1fb5b626b",
  "scripts/__tests__/conformance-provenance.test.mjs": "c12334f25dca21d4c8133a4e9c1bcbf569335b854dbfab4f73683e964cddd8ec",
  "scripts/__tests__/openai-worker-review-wire.test.mjs": "6799c971a773f04cd39d8e134c042474d23bfb1e949348df2e382b6fceb10023",
  "scripts/__tests__/published-artifact-drift.test.mjs": "3bc8e9f51d4e71b274217a7afa56a7df1f9f76af65f240a01ec3b56e321a6b9f",
  "scripts/__tests__/sync-openapi-retry.test.mjs": "67828e32c4fb6ad007ab0b940625f5c40edfbde22149eddf7e0de5527f78b41a",
  "scripts/analytics-tripwire.sh": "ddc434ddb44b7e7c9cb55f935d3b64c2b7e4e299fe7da1398f107e020068defd",
  "scripts/assert-publish-anchor.mjs": "3f256bb41969b75db8cb4be5cd5758a15b604f67b4770997f1ba57d22d951230",
  "scripts/audit-mcp-refs.mjs": "afd2486b3cf3c268636f7eb4ddbd3c1140d140f4486d178f688a694361f35600",
  "scripts/canary-mcp.mjs": "85dc19431bbd2677c944645b67e1132922c286cdb37a6332aa716a6512225243",
  "scripts/check-openai-review-descriptor.mjs": "494acb06357f8ce080cb755b96d40b4959811223271b6d1419448e4fa76065cd",
  "scripts/conformance/applicability.json": "a561dcb009c695cd3d5287aaa1aef6f0c43518b38a377c6ed5770b1f4d68eb25",
  "scripts/conformance/classify.mjs": "5e6980e479636d4dbd15601f7c025ce1ec01cb5b9d4ee515d791ef080f876609",
  "scripts/conformance/evidence.mjs": "4803463b4d93398887082ef2d682893c9b52f97ccd51d58ae6d8aa19db56d79e",
  "scripts/conformance/http-bridge.mjs": "7a3bc42514bfb3f8046321fb9e6ccb3a22905292f11fac157c84cc86e32be0a0",
  "scripts/conformance/inspector-smoke.mjs": "d0502871276da2a2855f97408569a460957e79536cc8dfd916bfff62b48449ff",
  "scripts/conformance/pinned-versions.mjs": "676d1f9706c19b52ce483a31d5fe3ab4ce0eb984e429a8c71531d945a75cd4b5",
  "scripts/conformance/provenance.mjs": "1031655d961085d98ef09d831abfe366beec4e8adb9bb3171e31922fc15ada55",
  "scripts/conformance/run-phase0.mjs": "8298c4dc4c586622b79caa6a7f86d6376b3970d52c2b8a8af1dcb74585b112f7",
  "scripts/conformance/validate-baseline.mjs": "8acd56c5364c488280280af7b39e6f94091e3544103fb6bd56b1cc954af555e7",
  "scripts/generate-agent-onboarding.mjs": "64c195c341c9c822f17026617db56326b34282a90f5c16a10ddf5bb195360e06",
  "scripts/generate-openai-submission.mjs": "fd5fe26e6b5d19cbdeed80326d2abadb695c7c966a68e2796649d43938c23aff",
  "scripts/generate-public-capability-contract.mjs": "7c6f08e3a28c9bc2cd50a9e791571eaf4987b2c618f4c614ae55c9ed811cf1f2",
  "scripts/no-legacy-region.sh": "560cc8a7b9c35d39418f5331833eaa28840d4528e7bfc863918b8d5ff2574ef7",
  "scripts/no-public-leak.sh": "b1f545a1bce2fc8f3e227f9bff41e737ea398ef5f15001403e4b8c7bfc684855",
  "scripts/postinstall.js": "02947d11d324048f69bc92d253d7c41f947aa338d1d6315b1579492689d462e3",
  "scripts/published-artifact-drift.mjs": "29435fd9b25625db5f6835e0b11b0528daf7345eef1421c6c826879be00b4f95",
  "scripts/sync-openapi.mjs": "3d72c61a014b53887906fade05a13631e06d47977891b4b4fdb9a337322a4f32",
  "scripts/test-openai-full-compose.mjs": "726217ac19463dfba5243fb5bc4843b19913969ea6e0d76316dbc7a7d1010865",
  "scripts/validate-openai-submission-schema.mjs": "a3fa908a5ea83d6468f2d77345e464f1832845f45677df2627d2eebb423c548a",
  "tsconfig.json": "fee86899bb77179611ed16b73572159d567e76a4717522e567900dbb17ac0804",
  "workers/remote-mcp/scripts/capture-openai-review.mjs": "155921985f9df2f9ed029691b7baf021c8737a7d9cb485dc366ab7ff9c890be2",
  "workers/remote-mcp/tsconfig.json": "03d5bac68efb117ed224ec2091bb0918370cb4453ae2fa04bd5fd1d7aff26f54",
});
export const APPROVED_REVIEW_FILE_HASHES = Object.freeze({
  "marketplace/openai/SUBMISSION.md": "e12e0ba723c42c09d7fff01c6f7eeca158750bb88d573ed21a7aab03494eccb7",
  "marketplace/openai/chatgpt-app-submission.json": "3b80cf9422bb7e2779497cb81b1638fae253f0af32d5445aeddd2e0e27d9f1cf",
  "marketplace/openai/chatgpt-app-submission.v1.schema.json": "aa7d1bd554e6c615d411c03e5b73bb464816be603461eb5813bb589645550304",
  "marketplace/openai/frihet-composer-dark.png": "7e3d1d5c560ecc41135a42421c343101d2ed043b9cfef979a8e80d57d9471e0b",
  "marketplace/openai/frihet-composer.png": "3f2260512beeb70b248f515f43ea669015f060ef6427dba6ed89128649c12f51",
  "marketplace/openai/frihet-directory-dark.png": "7e96f15a8b06125964ccee51d2314835fb7c62968766a8625f7be204fe9b15ab",
  "src/__tests__/fixtures/openai-review-descriptor.snapshot.json": "799b5e628ee0baacd1f50d61f2e584fce3931c9f0e87cbb7b6ab77be63b47088",
  "src/__tests__/fixtures/public-capability-contract.json": "66621eaf7bf8487db21b5eaf61d1d33264d532ef1949189a7785a1b61f017789",
  "workers/remote-mcp/public-openai/releases.json": "83d3a24a90dac747e0e7a0bd28c76f13c9a84d86e48a6900f077d45d3e59e8a7",
});

const CODE_EXTENSION_SET = new Set(CODE_EXTENSIONS);
const EXCLUDED_DIRECTORY_SET = new Set(EXCLUDED_DIRECTORIES);
const TEST_FILE_RE = /\.(?:spec|test)\.[cm]?[jt]sx?$/u;
const CONFIG_IDENTIFIER_RE = /(?:POSTHOG|ANALYTICS).*(?:API_?KEY|CONFIG|DISABLED|ENABLED|ENDPOINT|HOST|INIT|KEY|PROJECT|PROVIDER|PROXY|SECRET|TOKEN|URL|WRITE_?KEY)|(?:API_?KEY|CONFIG|ENDPOINT|HOST|KEY|PROJECT|PROXY|SECRET|TOKEN|URL|WRITE_?KEY).*(?:POSTHOG|ANALYTICS)|(?:^|_)PH_.*(?:API_?KEY|HOST|KEY|PROJECT|TOKEN|URL)|(?:INGEST|CAPTURE).*(?:API_?KEY|CONFIG|ENDPOINT|HOST|KEY|PROXY|SECRET|TOKEN|URL)/iu;
const ANALYTICS_RECEIVER_RE = /^(?:analytics|analyticsClient|analyticsSdk|ph|posthog|posthogClient|posthogSdk)$/iu;
const DISCLOSURE_NAME_RE = /(?:copy|description|disclosure|effect|html|notice|privacy|recipient|summary|text)$/iu;
const BARE_EMITTER_RE = /^(?:analyticsCapture|captureAnalytics|captureEvent|emitAnalytics|posthogCapture|sendAnalytics|trackAnalytics|trackEvent)$/iu;
const REQUESTISH_METHODS = new Set(["add", "addAll", "connect", "fetch", "fetchLater", "get", "open", "post", "put", "redirect", "register", "request", "send", "sendBeacon"]);
const DOM_RESOURCE_TAGS = new Set([
  "audio",
  "base",
  "embed",
  "form",
  "iframe",
  "image",
  "img",
  "input",
  "link",
  "object",
  "script",
  "source",
  "track",
  "use",
  "video",
]);
const URL_BEARING_ATTRIBUTES = new Set([
  "action",
  "data",
  "formaction",
  "href",
  "ping",
  "poster",
  "src",
  "srcset",
  "xlink:href",
]);
const HTML_INJECTION_PROPERTIES = new Set(["cssText", "innerHTML", "outerHTML", "srcdoc"]);
const HTML_INJECTION_METHODS = new Set([
  "createContextualFragment",
  "insertAdjacentHTML",
  "parseFromString",
  "write",
  "writeln",
]);
const DYNAMIC_EXECUTION_NAMES = new Set(["createRequire", "eval", "Function", "require", "WebAssembly"]);
const NETWORK_MODULE_RE = /^(?:axios|cloudflare:sockets|dns|got|node-fetch|undici|node:dgram|node:dns|node:http|node:http2|node:https|node:net|node:tls|dgram|http|http2|https|net|tls)$/u;
const NETWORK_GLOBAL_MEMBER_NAMES = new Set([
  "Audio",
  "EventSource",
  "Image",
  "SharedWorker",
  "WebSocket",
  "WebTransport",
  "Worker",
  "XMLHttpRequest",
  "fetch",
  "fetchLater",
  "sendBeacon",
]);
const NAVIGATION_RECEIVER_RE = /^(?:(?:globalThis|parent|self|top|window)\.)*(?:document\.)?location$/u;
const DANGEROUS_EXECUTION_MODULE_RE = /^(?:node:)?(?:child_process|module|vm|worker_threads)$/u;
const TEST_PATH_RE = /(?:^|\/)(?:\.wrangler|__tests__|coverage|dist|node_modules)(?:\/|$)|\.(?:spec|test)(?:\.[cm]?[jt]sx?)?(?:$|[/?#])/iu;

function isApprovedDistImport(file, moduleValue) {
  return APPROVED_DIST_IMPORTS[file]?.includes(moduleValue) === true;
}

function isAnalyticsModule(value) {
  return ANALYTICS_MODULE_PATTERNS.some((pattern) => pattern.test(value));
}

function analyticsModuleInLocator(value) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed URL escapes remain searchable in their original form.
  }
  return /(?:@amplitude\/analytics-|@google-analytics\/data|@opentelemetry\/exporter-|@posthog\/|@rudderstack\/|@segment\/analytics-|@vercel\/analytics|(?:^|[/@:])analytics-(?:browser|node)|(?:^|[/@:])heap-js|(?:^|[/@:])mixpanel(?:-browser)?|(?:^|[/@:])plausible-tracker|(?:^|[/@:])posthog(?:-js|-node|-react-native)?|(?:^|[/@:])react-ga4|(?:^|[/@:])rudder-sdk-js)/iu.test(decoded);
}

function isAnalyticsConfigIdentifier(value) {
  if (DISCLOSURE_NAME_RE.test(value) || /(?:PRIVACY|LEGAL).*(?:LINK|URL)(?:_|$)/iu.test(value)) return false;
  return CONFIG_IDENTIFIER_RE.test(value);
}

function providerEndpointReason(value) {
  const compact = value.replace(/\\\//gu, "/");
  if (/https?:\/\/(?:[a-z0-9-]+\.)*posthog\.com\/(?:docs|legal|privacy)(?=[/?#\s"'<>]|$)/iu.test(compact)) {
    return null;
  }
  if (/https?:\/\/(?:[a-z0-9-]+\.)*posthog\.com(?:[/:?#]|$)/iu.test(compact)) {
    return "PostHog network authority";
  }
  if (/https?:\/\/[^\s"'<>]*(?:posthog-(?:js|node)|@posthog\/)(?=[@/?#\s"'<>]|$)/iu.test(compact)) {
    return "PostHog SDK resource URL";
  }
  if (/(?:^|["'`(=:\s])\/\/(?:[^\s"'<>]*\.)?posthog\.com(?:[/:?#]|$)/iu.test(compact)) {
    return "scheme-relative PostHog authority";
  }
  return null;
}

function analyticsRouteReason(value) {
  const compact = value.replace(/\\\//gu, "/");
  if (/(?:^|[/?#])(?:analytics|capture|decide|engage|ingest)(?:[/?#]|$)/iu.test(compact)) {
    return "analytics/ingest route";
  }
  if (/(?:^|[/?#])(?:batch)(?:[/?#]|$)/iu.test(compact) && /(?:event|analytic|posthog|telemetry)/iu.test(compact)) {
    return "analytics batch route";
  }
  return null;
}

function scriptKind(file) {
  if (/\.tsx$/iu.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/iu.test(file)) return ts.ScriptKind.JSX;
  if (/\.(?:cjs|js|mjs)$/iu.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAwaitExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression?.(current)
  ) {
    current = current.expression;
  }
  return current;
}

function collectConstBindings(sourceFile) {
  const bindings = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      // The evaluator is intentionally not a scope interpreter. A repeated
      // name is therefore unresolvable, never "last declaration wins" (which
      // would let shadowing hide a dangerous constant from the gate).
      bindings.set(node.name.text, bindings.has(node.name.text) ? null : node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function staticText(node, bindings, resolving = new Set()) {
  if (!node) return null;
  const current = unwrapExpression(node);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isNumericLiteral(current)) return current.text;
  if (ts.isIdentifier(current)) {
    if (resolving.has(current.text)) return null;
    const initializer = bindings.get(current.text);
    if (!initializer) return null;
    const next = new Set(resolving);
    next.add(current.text);
    return staticText(initializer, bindings, next);
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(current.left, bindings, resolving);
    const right = staticText(current.right, bindings, resolving);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    for (const span of current.templateSpans) {
      const expression = staticText(span.expression, bindings, resolving);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === "concat"
  ) {
    const head = staticText(current.expression.expression, bindings, resolving);
    const tail = current.arguments.map((argument) => staticText(argument, bindings, resolving));
    return head === null || tail.some((value) => value === null)
      ? null
      : head + tail.join("");
  }
  if (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === "join"
    && ts.isArrayLiteralExpression(unwrapExpression(current.expression.expression))
  ) {
    const array = unwrapExpression(current.expression.expression);
    const separator = current.arguments.length === 0
      ? ","
      : staticText(current.arguments[0], bindings, resolving);
    if (separator === null) return null;
    const values = array.elements.map((element) => staticText(element, bindings, resolving));
    return values.some((value) => value === null) ? null : values.join(separator);
  }
  return null;
}

function approximateText(node, bindings, resolving = new Set()) {
  if (!node) return null;
  const current = unwrapExpression(node);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isIdentifier(current)) {
    if (resolving.has(current.text)) return "__DYNAMIC__";
    const initializer = bindings.get(current.text);
    if (!initializer) return "__DYNAMIC__";
    const next = new Set(resolving);
    next.add(current.text);
    return approximateText(initializer, bindings, next);
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = approximateText(current.left, bindings, resolving);
    const right = approximateText(current.right, bindings, resolving);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    for (const span of current.templateSpans) {
      value += approximateText(span.expression, bindings, resolving) ?? "__DYNAMIC__";
      value += span.literal.text;
    }
    return value;
  }
  return "__DYNAMIC__";
}

function normalizedSource(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/gu, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareFrozenSource(file, source) {
  const findings = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const bindings = collectConstBindings(sourceFile);
  for (const [key, expected] of Object.entries(APPROVED_STATIC_BINDINGS)) {
    const [expectedFile, name] = key.split("|");
    if (expectedFile !== file) continue;
    const actual = staticText(bindings.get(name), bindings);
    if (actual !== expected) {
      findings.push({
        file,
        line: 1,
        column: 1,
        code: "STATIC_AUTHORITY_DRIFT",
        detail: `${name} — expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
      });
    }
  }

  const expectedHash = APPROVED_SOURCE_FILE_HASHES[file];
  if (expectedHash) {
    const actual = sha256(source.replace(/\r\n?/gu, "\n"));
    if (actual !== expectedHash) {
      findings.push({
        file,
        line: 1,
        column: 1,
        code: "APPROVED_SINK_SOURCE_DRIFT",
        detail: `full reviewed source — expected ${expectedHash}, found ${actual}`,
      });
    }
  }
  return findings;
}

function compareLockfileHash(file, source) {
  const expected = APPROVED_LOCKFILE_HASHES[file];
  if (!expected) return [];
  const actual = sha256(source.replace(/\r\n?/gu, "\n"));
  return actual === expected
    ? []
    : [{
        file,
        line: 1,
        column: 1,
        code: "LOCKFILE_DRIFT",
        detail: `expected ${expected}, found ${actual}`,
      }];
}

function compareConfigFileHash(file, source) {
  const expected = APPROVED_CONFIG_FILE_HASHES[file];
  if (!expected) return [];
  const actual = sha256(source);
  return actual === expected
    ? []
    : [{
        file,
        line: 1,
        column: 1,
        code: "DEPLOYMENT_CONFIG_DRIFT",
        detail: `expected ${expected}, found ${actual}`,
      }];
}

function resolvedPropertyName(expression, bindings) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) return staticText(expression.argumentExpression, bindings);
  return null;
}

function receiverExpression(expression) {
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return expression.expression;
  }
  return null;
}

function enclosingFunctionName(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current)
      || ts.isMethodDeclaration(current)
      || ts.isFunctionExpression(current)
      || ts.isArrowFunction(current)
    ) {
      if (current.name && ts.isIdentifier(current.name)) return current.name.text;
      if (
        current.parent
        && ts.isVariableDeclaration(current.parent)
        && ts.isIdentifier(current.parent.name)
      ) {
        return current.parent.name.text;
      }
      return "<anonymous>";
    }
    current = current.parent;
  }
  return "<module>";
}

function isNetworkReference(node, networkTainted, bindings) {
  const expression = unwrapExpression(node);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return isNetworkReference(expression.right, networkTainted, bindings);
  }
  if (
    ts.isElementAccessExpression(expression)
    && ts.isArrayLiteralExpression(unwrapExpression(expression.expression))
  ) {
    const indexText = staticText(expression.argumentExpression, bindings);
    const index = indexText === null ? Number.NaN : Number(indexText);
    const array = unwrapExpression(expression.expression);
    return Number.isInteger(index) && array.elements[index]
      ? isNetworkReference(array.elements[index], networkTainted, bindings)
      : false;
  }
  if (ts.isCallExpression(expression)) {
    const moduleValue = importModuleValue(expression, bindings);
    if (moduleValue !== null && NETWORK_MODULE_RE.test(moduleValue)) return true;
    const callee = unwrapExpression(expression.expression);
    const reflectGetReceiver = expression.arguments[0]
      ? normalizedSource(expression.arguments[0], node.getSourceFile())
      : "";
    const reflectGetKey = expression.arguments[1]
      ? staticText(expression.arguments[1], bindings)
      : null;
    if (
      normalizedSource(callee, node.getSourceFile()) === "Reflect.get"
      && expression.arguments.length >= 2
      && /^(?:globalThis|navigator|self|window)$/u.test(reflectGetReceiver)
      && (reflectGetKey === null || NETWORK_GLOBAL_MEMBER_NAMES.has(reflectGetKey))
    ) {
      return true;
    }
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const method = resolvedPropertyName(callee, bindings);
      const receiver = receiverExpression(callee);
      if (method === "bind" && receiver) {
        return isNetworkReference(receiver, networkTainted, bindings);
      }
      if (method === "open" && receiver && /^(?:globalThis\.|window\.)?caches$/u.test(normalizedSource(receiver, node.getSourceFile()))) {
        return true;
      }
      if (method === "create" && receiver && isNetworkReference(receiver, networkTainted, bindings)) {
        return true;
      }
    }
    return false;
  }
  if (ts.isNewExpression(expression)) {
    return isNetworkConstructor(expression, networkTainted, bindings);
  }
  if (ts.isIdentifier(expression)) {
    return NETWORK_GLOBAL_MEMBER_NAMES.has(expression.text)
      || ["importScripts", "open"].includes(expression.text)
      || networkTainted.has(expression.text);
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const method = resolvedPropertyName(expression, bindings);
    const receiver = receiverExpression(expression);
    const receiverText = receiver ? normalizedSource(receiver, node.getSourceFile()) : "";
    if (
      ts.isElementAccessExpression(expression)
      && method === null
      && /^(?:globalThis|navigator|self|window)$/u.test(receiverText)
    ) {
      return true;
    }
    if (["fetch", "fetchLater"].includes(method ?? "") && /^(?:globalThis|self|window)$/u.test(receiverText)) return true;
    if (method === "sendBeacon" && receiverText === "navigator") return true;
    if (method === "redirect") return true;
    if (["assign", "replace"].includes(method ?? "") && NAVIGATION_RECEIVER_RE.test(receiverText)) return true;
    if (method === "serviceWorker" && /^(?:globalThis\.|window\.)?navigator$/u.test(receiverText)) return true;
    if (method === "open" && /^(?:globalThis\.|window\.)?caches$/u.test(receiverText)) return true;
    if (receiver && expressionUsesTaint(receiver, networkTainted)) return true;
    if (["apply", "bind", "call"].includes(method ?? "") && receiver) {
      return isNetworkReference(receiver, networkTainted, bindings);
    }
  }
  return false;
}

function isNetworkCall(node, networkTainted, bindings) {
  if (!ts.isCallExpression(node)) return false;
  const expression = unwrapExpression(node.expression);
  if (ts.isIdentifier(expression)) {
    return ["fetch", "fetchLater", "got", "importScripts", "open"].includes(expression.text) || networkTainted.has(expression.text);
  }
  if (ts.isCallExpression(expression)) {
    return isNetworkReference(expression, networkTainted, bindings);
  }
  if (
    (ts.isBinaryExpression(expression) || ts.isElementAccessExpression(expression))
    && isNetworkReference(expression, networkTainted, bindings)
  ) {
    return true;
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return false;
  }
  const method = resolvedPropertyName(expression, bindings);
  const calleeText = normalizedSource(expression, node.getSourceFile());
  if (/^(?:(?:globalThis|self|window)\.)?Response\.redirect$/u.test(calleeText)) return true;
  if (
    calleeText === "Reflect.apply"
    && node.arguments[0]
    && isNetworkReference(node.arguments[0], networkTainted, bindings)
  ) {
    return true;
  }
  if (["fetch", "fetchLater", "redirect", "sendBeacon"].includes(method ?? "")) return true;
  const receiver = receiverExpression(expression);
  if (
    receiver
    && ["apply", "call"].includes(method ?? "")
    && isNetworkReference(receiver, networkTainted, bindings)
  ) {
    return true;
  }
  const receiverText = receiver ? normalizedSource(receiver, node.getSourceFile()) : "";
  if (method === "set" && staticText(node.arguments[0], bindings)?.toLowerCase() === "location") return true;
  if (["assign", "replace"].includes(method ?? "") && NAVIGATION_RECEIVER_RE.test(receiverText)) return true;
  if (method === "open" && /^(?:globalThis|window)$/u.test(receiverText)) return true;
  if (method === "request" && /^(?:globalThis\.)?(?:http|https)$/u.test(receiverText)) return true;
  if (["get", "post", "request"].includes(method ?? "") && /^(?:axios|got)$/u.test(receiverText)) return true;
  if (method === "open" && /(?:^|\.)xhr$/iu.test(receiverText)) return true;
  if (method === "register" && /^(?:globalThis\.|window\.)?navigator\.serviceWorker$/u.test(receiverText)) return true;
  if (receiver && isNetworkReference(receiver, networkTainted, bindings)) return true;
  if (receiver && expressionUsesTaint(receiver, networkTainted) && REQUESTISH_METHODS.has(method ?? "")) return true;
  return false;
}

function isNetworkConstructor(node, networkTainted, bindings) {
  if (!ts.isNewExpression(node)) return false;
  const callee = normalizedSource(node.expression, node.getSourceFile());
  if (/^(?:Audio|EventSource|Image|SharedWorker|WebSocket|WebTransport|Worker|XMLHttpRequest)$/u.test(callee) || networkTainted.has(callee)) return true;
  const expression = unwrapExpression(node.expression);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const receiver = receiverExpression(expression);
    const receiverText = receiver ? normalizedSource(receiver, node.getSourceFile()) : "";
    const constructorName = resolvedPropertyName(expression, bindings);
    return ["globalThis", "self", "window"].includes(receiverText)
      && ["Audio", "EventSource", "Image", "SharedWorker", "WebSocket", "WebTransport", "Worker", "XMLHttpRequest"].includes(constructorName ?? "");
  }
  return false;
}

function isDynamicExecutionReference(node, dynamicTainted, bindings) {
  const expression = unwrapExpression(node);
  if (
    ts.isElementAccessExpression(expression)
    && ts.isArrayLiteralExpression(unwrapExpression(expression.expression))
  ) {
    const indexText = staticText(expression.argumentExpression, bindings);
    const index = indexText === null ? Number.NaN : Number(indexText);
    const array = unwrapExpression(expression.expression);
    return Number.isInteger(index) && array.elements[index]
      ? isDynamicExecutionReference(array.elements[index], dynamicTainted, bindings)
      : false;
  }
  if (ts.isCallExpression(expression)) {
    const callee = unwrapExpression(expression.expression);
    if (
      normalizedSource(callee, node.getSourceFile()) === "Reflect.get"
      && expression.arguments.length >= 2
      && ["globalThis", "window"].includes(normalizedSource(expression.arguments[0], node.getSourceFile()))
      && DYNAMIC_EXECUTION_NAMES.has(staticText(expression.arguments[1], bindings) ?? "")
    ) {
      return true;
    }
  }
  if (ts.isIdentifier(expression)) {
    return DYNAMIC_EXECUTION_NAMES.has(expression.text) || dynamicTainted.has(expression.text);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return isDynamicExecutionReference(expression.right, dynamicTainted, bindings);
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const name = resolvedPropertyName(expression, bindings);
    const receiver = receiverExpression(expression);
    const receiverText = receiver ? normalizedSource(receiver, node.getSourceFile()) : "";
    // Any extracted `.constructor` can be the Function constructor
    // (`(()=>{}).constructor`, `globalThis.constructor.constructor`, etc.).
    // Treat it as dynamic execution taint instead of attempting to prove the
    // receiver's runtime prototype chain.
    if (name === "constructor") return true;
    if (["_linkedBinding", "binding", "getBuiltinModule", "require"].includes(name ?? "")) return true;
    if (["globalThis", "self", "window"].includes(receiverText) && DYNAMIC_EXECUTION_NAMES.has(name ?? "")) return true;
    if (
      receiver
      && ["Module", "compile", "instantiate", "instantiateStreaming"].includes(name ?? "")
      && isDynamicExecutionReference(receiver, dynamicTainted, bindings)
    ) {
      return true;
    }
    if (receiver && ["apply", "bind", "call"].includes(name ?? "")) {
      return isDynamicExecutionReference(receiver, dynamicTainted, bindings);
    }
  }
  return false;
}

function collectSyntacticCallables(sourceFile) {
  const callables = new Set();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) callables.add(node.name.text);
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && (ts.isArrowFunction(unwrapExpression(node.initializer)) || ts.isFunctionExpression(unwrapExpression(node.initializer)))
    ) {
      callables.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return callables;
}

function isPromiseExecutorResolver(identifier) {
  let current = identifier.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const firstParameter = current.parameters[0]?.name;
      return Boolean(
        firstParameter
        && ts.isIdentifier(firstParameter)
        && firstParameter.text === identifier.text
        && ts.isNewExpression(current.parent)
        && normalizedSource(current.parent.expression, identifier.getSourceFile()) === "Promise"
        && current.parent.arguments?.[0] === current
      );
    }
    current = current.parent;
  }
  return false;
}

function isProvablyCallable(node, bindings, syntacticCallables, resolving = new Set()) {
  if (!node) return false;
  const expression = unwrapExpression(node);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return true;
  if (ts.isIdentifier(expression)) {
    if (syntacticCallables.has(expression.text) || isPromiseExecutorResolver(expression)) return true;
    if (resolving.has(expression.text)) return false;
    const initializer = bindings.get(expression.text);
    if (!initializer) return false;
    const next = new Set(resolving);
    next.add(expression.text);
    return isProvablyCallable(initializer, bindings, syntacticCallables, next);
  }
  if (ts.isConditionalExpression(expression)) {
    return isProvablyCallable(expression.whenTrue, bindings, syntacticCallables, resolving)
      && isProvablyCallable(expression.whenFalse, bindings, syntacticCallables, resolving);
  }
  if (ts.isCallExpression(expression)) {
    const callee = unwrapExpression(expression.expression);
    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
      && resolvedPropertyName(callee, bindings) === "bind"
    ) {
      return isProvablyCallable(receiverExpression(callee), bindings, syntacticCallables, resolving);
    }
  }
  return false;
}

function isTimerReference(node, bindings, resolving = new Set()) {
  if (!node) return false;
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    if (["setInterval", "setTimeout"].includes(expression.text)) return true;
    if (resolving.has(expression.text)) return false;
    const initializer = bindings.get(expression.text);
    if (!initializer) return false;
    const next = new Set(resolving);
    next.add(expression.text);
    return isTimerReference(initializer, bindings, next);
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const receiver = receiverExpression(expression);
    const name = resolvedPropertyName(expression, bindings);
    const receiverText = receiver ? normalizedSource(receiver, node.getSourceFile()) : "";
    if (["globalThis", "self", "window"].includes(receiverText) && ["setInterval", "setTimeout"].includes(name ?? "")) {
      return true;
    }
    if (name === "bind" && receiver) return isTimerReference(receiver, bindings, resolving);
  }
  return false;
}

function timerCallbackArgument(node, bindings) {
  if (!ts.isCallExpression(node)) return null;
  const callee = unwrapExpression(node.expression);
  if (isTimerReference(callee, bindings)) return node.arguments[0] ?? null;
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const invocation = resolvedPropertyName(callee, bindings);
    const timer = receiverExpression(callee);
    if (timer && isTimerReference(timer, bindings)) {
      if (invocation === "call") return node.arguments[1] ?? null;
      if (invocation === "apply") {
        const args = node.arguments[1] ? unwrapExpression(node.arguments[1]) : null;
        return args && ts.isArrayLiteralExpression(args) ? args.elements[0] ?? null : null;
      }
    }
  }
  if (
    normalizedSource(callee, node.getSourceFile()) === "Reflect.apply"
    && node.arguments[0]
    && isTimerReference(node.arguments[0], bindings)
  ) {
    const args = node.arguments[2] ? unwrapExpression(node.arguments[2]) : null;
    return args && ts.isArrayLiteralExpression(args) ? args.elements[0] ?? null : null;
  }
  return null;
}

function sinkTarget(node, bindings) {
  if (ts.isNewExpression(node)) return node.arguments?.[0] ?? null;
  const expression = unwrapExpression(node.expression);
  if (
    normalizedSource(expression, node.getSourceFile()) === "Reflect.apply"
    && node.arguments[2]
  ) {
    const args = unwrapExpression(node.arguments[2]);
    return ts.isArrayLiteralExpression(args) ? args.elements[0] ?? null : node.arguments[2];
  }
  if (
    (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
    && resolvedPropertyName(expression, bindings) === "open"
  ) {
    const receiver = receiverExpression(expression);
    const receiverText = receiver ? normalizedSource(receiver, node.getSourceFile()) : "";
    return /^(?:globalThis|window)$/u.test(receiverText)
      ? node.arguments[0] ?? null
      : node.arguments[1] ?? null;
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const invocation = resolvedPropertyName(expression, bindings);
    if (invocation === "set" && staticText(node.arguments[0], bindings)?.toLowerCase() === "location") {
      return node.arguments[1] ?? null;
    }
    if (invocation === "call") return node.arguments[1] ?? null;
    if (invocation === "apply") {
      const args = node.arguments[1] ? unwrapExpression(node.arguments[1]) : null;
      return args && ts.isArrayLiteralExpression(args) ? args.elements[0] ?? null : node.arguments[1] ?? null;
    }
  }
  return node.arguments[0] ?? null;
}

function sinkFingerprint(file, node, sourceFile, bindings) {
  const expression = ts.isCallExpression(node) ? unwrapExpression(node.expression) : node.expression;
  const callee = normalizedSource(expression, sourceFile);
  const target = sinkTarget(node, bindings);
  const targetSource = target ? normalizedSource(target, sourceFile) : "<missing>";
  return `${file}|${enclosingFunctionName(node)}|${callee}|${targetSource}`;
}

function bindingNames(name, out = []) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) bindingNames(element.name, out);
    }
  }
  return out;
}

function importBindingNames(namedBindings) {
  if (!namedBindings) return [];
  if (ts.isNamespaceImport(namedBindings)) return [namedBindings.name.text];
  if (ts.isNamedImports(namedBindings)) return namedBindings.elements.map((element) => element.name.text);
  return [];
}

function staticPropertyKey(name, bindings) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return staticText(name.expression, bindings);
  return null;
}

function expressionUsesTaint(node, tainted) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (ts.isIdentifier(current) && tainted.has(current.text)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function expressionLooksAnalytics(node, tainted, bindings) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (ts.isIdentifier(current) && (tainted.has(current.text) || ANALYTICS_RECEIVER_RE.test(current.text))) {
      found = true;
      return;
    }
    if (ts.isElementAccessExpression(current)) {
      const key = staticText(current.argumentExpression, bindings);
      if (key !== null && ANALYTICS_RECEIVER_RE.test(key)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function isBenignDisclosureInitializer(name, initializer, bindings) {
  if (!DISCLOSURE_NAME_RE.test(name)) return false;
  const value = staticText(initializer, bindings);
  return value !== null && !providerEndpointReason(value) && !analyticsRouteReason(value);
}

function isProviderDisclosureNode(node, bindings) {
  let current = node;
  while (current) {
    if (
      ts.isVariableDeclaration(current)
      && ts.isIdentifier(current.name)
      && current.initializer
      && DISCLOSURE_NAME_RE.test(current.name.text)
    ) {
      const value = staticText(current.initializer, bindings);
      return value !== null
        && /https?:\/\/(?:[a-z0-9-]+\.)*posthog\.com\/(?:docs|legal|privacy)(?:[/?#]|$)/iu.test(value)
        && !analyticsRouteReason(value);
    }
    current = current.parent;
  }
  return false;
}

function importModuleValue(node, bindings) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier ? staticText(node.moduleSpecifier, bindings) : null;
  }
  if (
    ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
    && node.moduleReference.expression
  ) {
    return staticText(node.moduleReference.expression, bindings);
  }
  if (ts.isCallExpression(node)) {
    const expression = unwrapExpression(node.expression);
    const dynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
    const requireCall = ts.isIdentifier(expression) && expression.text === "require";
    const moduleRequireCall = (
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    )
      && normalizedSource(receiverExpression(expression), node.getSourceFile()) === "module"
      && resolvedPropertyName(expression, bindings) === "require";
    if (dynamicImport || requireCall || moduleRequireCall) return staticText(node.arguments[0], bindings);
  }
  return null;
}

function isModuleLoaderCall(node, bindings) {
  if (!ts.isCallExpression(node)) return false;
  const expression = unwrapExpression(node.expression);
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(expression) && expression.text === "require") return true;
  return (
    ts.isPropertyAccessExpression(expression)
    || ts.isElementAccessExpression(expression)
  )
    && normalizedSource(receiverExpression(expression), node.getSourceFile()) === "module"
    && resolvedPropertyName(expression, bindings) === "require";
}

function htmlFragments(sourceFile, bindings) {
  const fragments = [];
  const seen = new Set();
  const visit = (node) => {
    if (
      ts.isStringLiteralLike(node)
      || ts.isTemplateExpression(node)
      || ts.isBinaryExpression(node)
      || ts.isCallExpression(node)
    ) {
      const text = staticText(node, bindings) ?? approximateText(node, bindings);
      if (
        text
        && /<(?:a|audio|base|button|embed|form|iframe|image|img|input|link|meta|object|script|source|style|track|use|video)\b|\bon[a-z]+\s*=|javascript:/iu.test(text)
        && !seen.has(text)
      ) {
        seen.add(text);
        fragments.push({ node, text: text.replace(/<\\\/script>/giu, "</script>") });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return fragments;
}

function splitSrcset(value) {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/u)[0])
    .filter(Boolean);
}

function htmlStartTags(fragment) {
  const tags = [];
  for (let index = 0; index < fragment.length; index += 1) {
    if (fragment.startsWith("<!--", index)) {
      const close = fragment.indexOf("-->", index + 4);
      index = close < 0 ? fragment.length : close + 2;
      continue;
    }
    if (fragment[index] !== "<" || !/[A-Za-z]/u.test(fragment[index + 1] ?? "")) continue;
    let cursor = index + 1;
    while (/[A-Za-z0-9:-]/u.test(fragment[cursor] ?? "")) cursor += 1;
    const tag = fragment.slice(index + 1, cursor).toLowerCase();
    const attrsStart = cursor;
    let quote = null;
    for (; cursor < fragment.length; cursor += 1) {
      const char = fragment[cursor];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        tags.push({ tag, attrs: fragment.slice(attrsStart, cursor), start: index, end: cursor });
        index = cursor;
        break;
      }
    }
  }
  return tags;
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", apos: "'", colon: ":", gt: ">", lt: "<", quot: '"' };
  return value.replace(/&(?:#(\d+);?|#x([0-9a-f]+);?|([a-z]+);)/giu, (match, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[name.toLowerCase()] ?? match;
  });
}

function parseHtmlAttributes(attrs) {
  const parsed = [];
  let cursor = 0;
  while (cursor < attrs.length) {
    while (/\s/u.test(attrs[cursor] ?? "")) cursor += 1;
    if (attrs[cursor] === "/") {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < attrs.length && !/[\s=]/u.test(attrs[cursor]) && attrs[cursor] !== "/") cursor += 1;
    if (cursor === start) {
      cursor += 1;
      continue;
    }
    const name = attrs.slice(start, cursor).toLowerCase();
    while (/\s/u.test(attrs[cursor] ?? "")) cursor += 1;
    let value = null;
    if (attrs[cursor] === "=") {
      cursor += 1;
      while (/\s/u.test(attrs[cursor] ?? "")) cursor += 1;
      const quote = attrs[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < attrs.length && attrs[cursor] !== quote) cursor += 1;
        value = attrs.slice(valueStart, cursor);
        if (attrs[cursor] === quote) cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < attrs.length && !/\s/u.test(attrs[cursor]) && attrs[cursor] !== "/") cursor += 1;
        value = attrs.slice(valueStart, cursor);
      }
    }
    parsed.push({ name, value });
  }
  return parsed;
}

function executableAttribute(tag, attribute, attrs = "") {
  if (attribute === "ping") return true;
  if (tag === "base") return attribute === "href";
  if (tag === "form") return attribute === "action";
  if (tag === "object") return attribute === "data";
  if (["button", "input"].includes(tag) && attribute === "formaction") return true;
  if (tag === "video" && attribute === "poster") return true;
  if (["audio", "embed", "iframe", "img", "input", "script", "source", "track", "video"].includes(tag)) {
    return attribute === "src" || attribute === "srcset" || (tag === "script" && attribute === "href");
  }
  if (["image", "use"].includes(tag)) return attribute === "href" || attribute === "xlink:href";
  if (tag === "link" && attribute === "href") {
    return /\b(?:dns-prefetch|icon|manifest|modulepreload|prefetch|preload|preconnect|stylesheet)\b/iu.test(attrs);
  }
  return false;
}

function embeddedResources(file, fragment) {
  const resources = [];
  for (const { tag, attrs } of htmlStartTags(fragment)) {
    for (const attr of parseHtmlAttributes(attrs)) {
      const attribute = attr.name;
      const value = decodeHtmlEntities(attr.value ?? "");
      if (!executableAttribute(tag, attribute, attrs)) continue;
      const values = attribute === "srcset" ? splitSrcset(value) : [value];
      for (const candidate of values) resources.push(`${file}|${tag}|${candidate}`);
    }
  }
  for (const { tag, attrs } of htmlStartTags(fragment)) {
    const attributes = parseHtmlAttributes(attrs);
    const httpEquiv = decodeHtmlEntities(attributes.find((attr) => attr.name === "http-equiv")?.value ?? "").toLowerCase();
    if (tag !== "meta" || httpEquiv !== "refresh") continue;
    const value = decodeHtmlEntities(attributes.find((attr) => attr.name === "content")?.value ?? "");
    const target = value ? /(?:^|;)\s*url\s*=\s*(.*)$/iu.exec(value)?.[1]?.trim() : null;
    if (target) resources.push(`${file}|meta-refresh|${target}`);
  }
  const cssBlocks = [];
  for (const match of fragment.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) cssBlocks.push(match[1]);
  for (const { attrs } of htmlStartTags(fragment)) {
    const style = parseHtmlAttributes(attrs).find((attr) => attr.name === "style")?.value;
    if (style) cssBlocks.push(decodeHtmlEntities(style));
  }
  for (const css of cssBlocks) {
    for (const match of css.matchAll(/\burl\(\s*(["']?)(.*?)\1\s*\)/giu)) {
      resources.push(`${file}|css-url|${match[2]}`);
    }
    for (const match of css.matchAll(/@import\s+(?:url\(\s*)?(["'])(.*?)\1\s*\)?/giu)) {
      resources.push(`${file}|css-import|${match[2]}`);
    }
    for (const match of css.matchAll(/\b(?:-webkit-)?image-set\(\s*([\s\S]*?)\)/giu)) {
      resources.push(`${file}|css-image-set|${match[1].trim() || "<dynamic>"}`);
    }
  }
  return resources;
}

function inlineScripts(fragment) {
  const scripts = [];
  const lower = fragment.toLowerCase();
  for (const startTag of htmlStartTags(fragment)) {
    if (startTag.tag !== "script") continue;
    const attributes = parseHtmlAttributes(startTag.attrs);
    if (attributes.some((attr) => ["href", "src"].includes(attr.name))) continue;
    if (attributes.find((attr) => attr.name === "type")?.value?.toLowerCase() === "application/json") continue;
    const tail = lower.slice(startTag.end + 1);
    const closeMatch = /<\/script(?=[\s/>])/iu.exec(tail);
    if (!closeMatch) continue;
    const close = startTag.end + 1 + closeMatch.index;
    const script = fragment.slice(startTag.end + 1, close);
    if (script.trim()) scripts.push(script);
  }
  return scripts;
}

function inlineEventHandlers(fragment) {
  const handlers = [];
  for (const { attrs } of htmlStartTags(fragment)) {
    for (const attribute of parseHtmlAttributes(attrs)) {
      const value = decodeHtmlEntities(attribute.value ?? "");
      if (attribute.name.startsWith("on") && value.trim()) handlers.push(value);
      if (["href", "src"].includes(attribute.name) && /^javascript:/iu.test(value)) {
        const script = value.replace(/^javascript:/iu, "");
        if (script.trim()) handlers.push(script);
      }
    }
  }
  return handlers;
}

function embeddedDocuments(fragment) {
  const documents = [];
  for (const { attrs } of htmlStartTags(fragment)) {
    for (const attribute of parseHtmlAttributes(attrs)) {
      if (attribute.name === "srcdoc" && attribute.value) documents.push(decodeHtmlEntities(attribute.value));
    }
  }
  return documents;
}

function jsxAttributeName(attribute, sourceFile) {
  return attribute.name.getText(sourceFile).toLowerCase();
}

function jsxAttributeValue(attribute, sourceFile, bindings) {
  if (!attribute.initializer) return null;
  if (ts.isStringLiteral(attribute.initializer)) return decodeHtmlEntities(attribute.initializer.text);
  if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
    return staticText(attribute.initializer.expression, bindings)
      ?? `<dynamic:${normalizedSource(attribute.initializer.expression, sourceFile)}>`;
  }
  return `<dynamic:${normalizedSource(attribute.initializer, sourceFile)}>`;
}

function jsxResources(file, node, sourceFile, bindings) {
  const tag = node.tagName.getText(sourceFile).toLowerCase();
  const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
  const customTag = !/^[a-z][a-z0-9:-]*$/u.test(node.tagName.getText(sourceFile));
  const rel = attributes.find((attribute) => jsxAttributeName(attribute, sourceFile) === "rel");
  const relValue = rel ? jsxAttributeValue(rel, sourceFile, bindings) ?? "" : "";
  const attrs = relValue ? `rel=${relValue}` : "";
  const resources = [];
  if (
    node.attributes.properties.some(ts.isJsxSpreadAttribute)
    && (customTag || DOM_RESOURCE_TAGS.has(tag) || ["audio", "base", "embed", "form", "input", "video"].includes(tag))
  ) {
    resources.push(`${file}|${customTag ? "jsx-component" : tag}|<spread>`);
  }
  for (const attribute of attributes) {
    const name = jsxAttributeName(attribute, sourceFile);
    const value = jsxAttributeValue(attribute, sourceFile, bindings) ?? "<dynamic>";
    const javascriptUrl = ["href", "src"].includes(name) && /^javascript:/iu.test(value);
    if (!executableAttribute(tag, name, attrs) && !(customTag && URL_BEARING_ATTRIBUTES.has(name)) && !javascriptUrl) continue;
    const values = name === "srcset" ? splitSrcset(value) : [value];
    for (const candidate of values) resources.push(`${file}|${customTag ? "jsx-component" : tag}|${candidate}`);
  }
  const httpEquiv = attributes.find((attribute) => jsxAttributeName(attribute, sourceFile) === "httpequiv");
  if ((httpEquiv ? jsxAttributeValue(httpEquiv, sourceFile, bindings) : "")?.toLowerCase() === "refresh") {
    const content = attributes.find((attribute) => jsxAttributeName(attribute, sourceFile) === "content");
    const value = content ? jsxAttributeValue(content, sourceFile, bindings) : null;
    resources.push(`${file}|meta-refresh|${value ?? "<dynamic>"}`);
  }
  const style = attributes.find((attribute) => jsxAttributeName(attribute, sourceFile) === "style");
  if (style?.initializer && ts.isJsxExpression(style.initializer) && style.initializer.expression) {
    const expression = unwrapExpression(style.initializer.expression);
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const value = staticText(property.initializer, bindings);
        if (value && /(?:url\(|@import|image-set\()/iu.test(value)) resources.push(`${file}|jsx-style|${value}`);
      }
    } else {
      resources.push(`${file}|jsx-style|<dynamic>`);
    }
  }
  return resources;
}

function jsxEmbeddedDocuments(node, sourceFile, bindings) {
  const documents = [];
  for (const attribute of node.attributes.properties.filter(ts.isJsxAttribute)) {
    if (jsxAttributeName(attribute, sourceFile) !== "srcdoc") continue;
    documents.push(jsxAttributeValue(attribute, sourceFile, bindings) ?? "<dynamic>");
  }
  return documents;
}

function reactCreateElementResources(file, node, sourceFile, bindings) {
  if (!ts.isCallExpression(node)) return [];
  const callee = normalizedSource(node.expression, sourceFile);
  if (!/^(?:(?:[A-Za-z_$][\w$]*)\.)?createElement$/u.test(callee)) return [];
  const rawTag = staticText(node.arguments[0], bindings);
  const tag = rawTag?.toLowerCase() ?? "jsx-component";
  const customTag = rawTag === null || !/^[a-z][a-z0-9:-]*$/u.test(rawTag);
  const props = node.arguments[1] ? unwrapExpression(node.arguments[1]) : null;
  if (!props || !ts.isObjectLiteralExpression(props)) {
    return props && (customTag || DOM_RESOURCE_TAGS.has(tag))
      ? [`${file}|${customTag ? "jsx-component" : tag}|<dynamic-props>`]
      : [];
  }
  const relProperty = props.properties.find(
    (property) => ts.isPropertyAssignment(property) && staticPropertyKey(property.name, bindings)?.toLowerCase() === "rel",
  );
  const rel = relProperty && ts.isPropertyAssignment(relProperty)
    ? staticText(relProperty.initializer, bindings) ?? ""
    : "";
  const resources = [];
  if (
    props.properties.some(ts.isSpreadAssignment)
    && (customTag || DOM_RESOURCE_TAGS.has(tag) || ["audio", "base", "embed", "form", "input", "video"].includes(tag))
  ) {
    resources.push(`${file}|${customTag ? "jsx-component" : tag}|<spread>`);
  }
  for (const property of props.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = staticPropertyKey(property.name, bindings)?.toLowerCase() ?? null;
    if (!name) continue;
    const value = staticText(property.initializer, bindings)
      ?? `<dynamic:${normalizedSource(property.initializer, sourceFile)}>`;
    const javascriptUrl = ["href", "src"].includes(name) && /^javascript:/iu.test(value);
    if (!executableAttribute(tag, name, rel ? `rel=${rel}` : "") && !(customTag && URL_BEARING_ATTRIBUTES.has(name)) && !javascriptUrl) continue;
    const values = name === "srcset" ? splitSrcset(value) : [value];
    for (const candidate of values) resources.push(`${file}|${customTag ? "jsx-component" : tag}|${candidate}`);
  }
  const httpEquiv = objectPropertyValue(props, "httpEquiv", bindings);
  if (staticText(httpEquiv, bindings)?.toLowerCase() === "refresh") {
    const content = objectPropertyValue(props, "content", bindings);
    resources.push(`${file}|meta-refresh|${content ? staticText(content, bindings) ?? "<dynamic>" : "<dynamic>"}`);
  }
  const style = objectPropertyValue(props, "style", bindings);
  if (style) {
    const styleObject = unwrapExpression(style);
    if (ts.isObjectLiteralExpression(styleObject)) {
      for (const property of styleObject.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const value = staticText(property.initializer, bindings);
        if (value && /(?:url\(|@import|image-set\()/iu.test(value)) resources.push(`${file}|jsx-style|${value}`);
      }
    } else {
      resources.push(`${file}|jsx-style|<dynamic>`);
    }
  }
  return resources;
}

function domResourceTag(node, sourceFile, bindings) {
  if (!ts.isCallExpression(node)) return null;
  const expression = unwrapExpression(node.expression);
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return null;
  if (resolvedPropertyName(expression, bindings) !== "createElement") return null;
  const receiver = normalizedSource(receiverExpression(expression), sourceFile);
  if (!/^(?:document|globalThis\.document|window\.document)$/u.test(receiver)) return null;
  const tag = staticText(node.arguments[0], bindings);
  return tag !== null && DOM_RESOURCE_TAGS.has(tag.toLowerCase()) ? tag.toLowerCase() : null;
}

function objectPropertyValue(node, wanted, bindings) {
  const object = unwrapExpression(node);
  if (!ts.isObjectLiteralExpression(object)) return null;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (staticPropertyKey(property.name, bindings)?.toLowerCase() === wanted.toLowerCase()) {
      return property.initializer;
    }
  }
  return null;
}

function redirectHeaderTarget(node, bindings) {
  if (!ts.isNewExpression(node)) return null;
  const callee = normalizedSource(node.expression, node.getSourceFile());
  if (callee === "Headers") {
    return node.arguments?.[0] ? objectPropertyValue(node.arguments[0], "location", bindings) : null;
  }
  if (callee !== "Response" || !node.arguments?.[1]) return null;
  const headers = objectPropertyValue(node.arguments[1], "headers", bindings);
  if (!headers) return null;
  const direct = objectPropertyValue(headers, "location", bindings);
  if (direct) return direct;
  const value = unwrapExpression(headers);
  return ts.isNewExpression(value) ? redirectHeaderTarget(value, bindings) : null;
}

function addFinding(findings, sourceFile, node, code, detail) {
  const start = node.getStart(sourceFile, false);
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  findings.push({
    file: sourceFile.fileName,
    line: position.line + 1,
    column: position.character + 1,
    code,
    detail,
  });
}

function isTypeOnlyContext(node) {
  let current = node;
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isInterfaceDeclaration(current)
      || ts.isTypeAliasDeclaration(current)
      || ts.isTypeNode?.(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function deduplicateFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.file}:${finding.line}:${finding.column}:${finding.code}:${finding.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function analyzeCode(file, source, { embedded = false } = {}) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const findings = [];
  const sinks = [];
  const resources = [];
  const bindings = collectConstBindings(sourceFile);
  const syntacticCallables = collectSyntacticCallables(sourceFile);
  const tainted = new Set();
  const networkTainted = new Set();
  const dynamicTainted = new Set();

  for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
    const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    findings.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      code: "PARSE_ERROR",
      detail: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    });
  }

  const seed = (node) => {
    if (ts.isParameter(node) && node.initializer) {
      if (isNetworkReference(node.initializer, networkTainted, bindings)) {
        for (const name of bindingNames(node.name)) networkTainted.add(name);
      }
      if (isDynamicExecutionReference(node.initializer, dynamicTainted, bindings)) {
        for (const name of bindingNames(node.name)) dynamicTainted.add(name);
      }
    }
    if (ts.isImportDeclaration(node)) {
      const moduleValue = importModuleValue(node, bindings);
      if (moduleValue !== null && isAnalyticsModule(moduleValue)) {
        addFinding(findings, sourceFile, node.moduleSpecifier, "ANALYTICS_SDK_IMPORT", moduleValue);
        if (node.importClause?.name) tainted.add(node.importClause.name.text);
        if (node.importClause?.namedBindings) {
          for (const name of importBindingNames(node.importClause.namedBindings)) tainted.add(name);
        }
      }
      if (moduleValue !== null && NETWORK_MODULE_RE.test(moduleValue)) {
        if (node.importClause?.name) networkTainted.add(node.importClause.name.text);
        if (node.importClause?.namedBindings) {
          for (const name of importBindingNames(node.importClause.namedBindings)) networkTainted.add(name);
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const moduleValue = importModuleValue(node, bindings);
      if (moduleValue !== null && isAnalyticsModule(moduleValue)) tainted.add(node.name.text);
      if (moduleValue !== null && NETWORK_MODULE_RE.test(moduleValue)) networkTainted.add(node.name.text);
    }
    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      if (
        (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
        && resolvedPropertyName(expression, bindings) === "then"
        && isNetworkReference(receiverExpression(expression), networkTainted, bindings)
      ) {
        for (const callback of node.arguments) {
          if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) continue;
          for (const parameter of callback.parameters) {
            for (const name of bindingNames(parameter.name)) networkTainted.add(name);
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const names = bindingNames(node.name);
      for (const name of names) {
        if (isAnalyticsConfigIdentifier(name)) {
          tainted.add(name);
          addFinding(findings, sourceFile, node.name, "ANALYTICS_CONFIG", name);
        } else if (
          ANALYTICS_RECEIVER_RE.test(name)
          && !isBenignDisclosureInitializer(name, node.initializer, bindings)
        ) {
          tainted.add(name);
        }
      }
      if (
        ts.isCallExpression(unwrapExpression(node.initializer))
        && importModuleValue(unwrapExpression(node.initializer), bindings) !== null
        && isAnalyticsModule(importModuleValue(unwrapExpression(node.initializer), bindings))
      ) {
        for (const name of names) tainted.add(name);
      }
      if (
        ts.isCallExpression(unwrapExpression(node.initializer))
        && importModuleValue(unwrapExpression(node.initializer), bindings) !== null
        && NETWORK_MODULE_RE.test(importModuleValue(unwrapExpression(node.initializer), bindings))
      ) {
        for (const name of names) networkTainted.add(name);
      }
      if (isNetworkReference(node.initializer, networkTainted, bindings)) {
        for (const name of names) networkTainted.add(name);
      }
      if (isDynamicExecutionReference(node.initializer, dynamicTainted, bindings)) {
        for (const name of names) dynamicTainted.add(name);
      }
      if (
        (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name))
      ) {
        const bindingSource = normalizedSource(unwrapExpression(node.initializer), sourceFile);
        for (const element of node.name.elements) {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
          const property = element.propertyName
            ? staticPropertyKey(element.propertyName, bindings)
            : element.name.text;
          const globalNetworkBinding = ["globalThis", "navigator", "self", "window"].includes(bindingSource)
            && NETWORK_GLOBAL_MEMBER_NAMES.has(property ?? "");
          const redirectBinding = /^(?:(?:globalThis|self|window)\.)?Response$/u.test(bindingSource)
            && property === "redirect";
          const navigationBinding = NAVIGATION_RECEIVER_RE.test(bindingSource)
            && ["assign", "replace"].includes(property ?? "");
          if (globalNetworkBinding || redirectBinding || navigationBinding) {
            networkTainted.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, seed);
  };
  seed(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    const propagate = (node) => {
      if (
        ts.isVariableDeclaration(node)
        && node.initializer
        && expressionLooksAnalytics(node.initializer, tainted, bindings)
      ) {
        for (const name of bindingNames(node.name)) {
          if (!tainted.has(name)) {
            tainted.add(name);
            changed = true;
          }
        }
      }
      if (
        ts.isVariableDeclaration(node)
        && node.initializer
        && isNetworkReference(node.initializer, networkTainted, bindings)
      ) {
        for (const name of bindingNames(node.name)) {
          if (!networkTainted.has(name)) {
            networkTainted.add(name);
            changed = true;
          }
        }
      }
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(unwrapExpression(node.left))
        && expressionLooksAnalytics(node.right, tainted, bindings)
      ) {
        const name = unwrapExpression(node.left).text;
        if (!tainted.has(name)) {
          tainted.add(name);
          changed = true;
        }
      }
      if (
        ts.isVariableDeclaration(node)
        && node.initializer
        && isDynamicExecutionReference(node.initializer, dynamicTainted, bindings)
      ) {
        for (const name of bindingNames(node.name)) {
          if (!dynamicTainted.has(name)) {
            dynamicTainted.add(name);
            changed = true;
          }
        }
      }
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(unwrapExpression(node.left))
        && isNetworkReference(node.right, networkTainted, bindings)
      ) {
        const name = unwrapExpression(node.left).text;
        if (!networkTainted.has(name)) {
          networkTainted.add(name);
          changed = true;
        }
      }
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(unwrapExpression(node.left))
        && isDynamicExecutionReference(node.right, dynamicTainted, bindings)
      ) {
        const name = unwrapExpression(node.left).text;
        if (!dynamicTainted.has(name)) {
          dynamicTainted.add(name);
          changed = true;
        }
      }
      ts.forEachChild(node, propagate);
    };
    propagate(sourceFile);
  }

  const inspect = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      resources.push(...jsxResources(file, node, sourceFile, bindings));
      for (const document of jsxEmbeddedDocuments(node, sourceFile, bindings)) {
        if (document === "<dynamic>" || document.startsWith("<dynamic:")) {
          resources.push(`${file}|srcdoc|${document}`);
          continue;
        }
        const nested = analyzeCode(`${file}#jsx-srcdoc`, `const html = ${JSON.stringify(document)};`);
        findings.push(...nested.findings);
        sinks.push(...nested.sinks);
        resources.push(...nested.resources);
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (isNetworkReference(element, networkTainted, bindings)) {
          addFinding(findings, sourceFile, element, "NETWORK_PRIMITIVE_ESCAPE", "network primitive stored in array");
        }
        if (isDynamicExecutionReference(element, dynamicTainted, bindings)) {
          addFinding(findings, sourceFile, element, "DYNAMIC_EXECUTION", "dynamic execution primitive stored in array");
        }
      }
    }
    if (ts.isPropertyAssignment(node) && isNetworkReference(node.initializer, networkTainted, bindings)) {
      addFinding(findings, sourceFile, node, "NETWORK_PRIMITIVE_ESCAPE", "network primitive stored in object");
    }
    if (ts.isPropertyAssignment(node) && isDynamicExecutionReference(node.initializer, dynamicTainted, bindings)) {
      addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", "dynamic execution primitive stored in object");
    }
    if (ts.isParameter(node) && node.initializer) {
      if (isDynamicExecutionReference(node.initializer, dynamicTainted, bindings)) {
        addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", "dynamic execution primitive used as default parameter");
      }
    }
    if (ts.isShorthandPropertyAssignment(node) && isNetworkReference(node.name, networkTainted, bindings)) {
      addFinding(findings, sourceFile, node, "NETWORK_PRIMITIVE_ESCAPE", "network primitive stored in object");
    }
    if (ts.isReturnStatement(node) && node.expression && isNetworkReference(node.expression, networkTainted, bindings)) {
      addFinding(findings, sourceFile, node, "NETWORK_PRIMITIVE_ESCAPE", "network primitive returned");
    }
    if (
      ts.isArrowFunction(node)
      && !ts.isBlock(node.body)
      && isNetworkReference(node.body, networkTainted, bindings)
    ) {
      addFinding(findings, sourceFile, node.body, "NETWORK_PRIMITIVE_ESCAPE", "network primitive returned");
    }
    if (ts.isIdentifier(node) && isAnalyticsConfigIdentifier(node.text) && !isTypeOnlyContext(node)) {
      addFinding(findings, sourceFile, node, "ANALYTICS_CONFIG", node.text);
    }
    if (ts.isElementAccessExpression(node)) {
      const key = staticText(node.argumentExpression, bindings);
      if (key !== null && isAnalyticsConfigIdentifier(key) && !isTypeOnlyContext(node)) {
        addFinding(findings, sourceFile, node, "ANALYTICS_CONFIG", key);
      }
      if (key !== null && ANALYTICS_RECEIVER_RE.test(key)) {
        addFinding(findings, sourceFile, node, "ANALYTICS_CODE_TOKEN", key);
      }
    }
    if (ts.isBindingElement(node) && node.propertyName) {
      const key = staticPropertyKey(node.propertyName, bindings);
      if (key !== null && isAnalyticsConfigIdentifier(key) && !isTypeOnlyContext(node)) {
        addFinding(findings, sourceFile, node.propertyName, "ANALYTICS_CONFIG", key);
      }
    }
    if (
      ts.isPropertyAssignment(node)
      || ts.isPropertyDeclaration(node)
      || ts.isPropertySignature(node)
      || ts.isMethodDeclaration(node)
      || ts.isMethodSignature(node)
    ) {
      const key = staticPropertyKey(node.name, bindings);
      if (key !== null && isAnalyticsConfigIdentifier(key) && !isTypeOnlyContext(node)) {
        addFinding(findings, sourceFile, node.name, "ANALYTICS_CONFIG", key);
      }
    }

    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const target = normalizedSource(node.left, sourceFile);
      const left = unwrapExpression(node.left);
      if (
        (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))
        && isNetworkReference(node.right, networkTainted, bindings)
      ) {
        addFinding(findings, sourceFile, node, "NETWORK_PRIMITIVE_ESCAPE", "network primitive assigned to property");
      }
      const computedNetworkMutation = (
        ts.isPropertyAccessExpression(left)
        || ts.isElementAccessExpression(left)
      )
        && ["globalThis", "navigator", "self", "window"].includes(normalizedSource(left.expression, sourceFile))
        && NETWORK_GLOBAL_MEMBER_NAMES.has(resolvedPropertyName(left, bindings) ?? "");
      if (/^(?:fetch|fetchLater|globalThis\.(?:XMLHttpRequest|fetch|fetchLater)|self\.(?:XMLHttpRequest|fetch|fetchLater)|window\.(?:XMLHttpRequest|fetch|fetchLater)|navigator\.sendBeacon)$/u.test(target) || computedNetworkMutation) {
        addFinding(findings, sourceFile, node.left, "NETWORK_MUTATION", target);
      }
      const navigationTarget = (
        ts.isPropertyAccessExpression(left)
        || ts.isElementAccessExpression(left)
      )
        && resolvedPropertyName(left, bindings) === "href"
        && NAVIGATION_RECEIVER_RE.test(normalizedSource(receiverExpression(left), sourceFile));
      if (NAVIGATION_RECEIVER_RE.test(target) || navigationTarget) {
        const destination = normalizedSource(node.right, sourceFile);
        sinks.push(`${file}|${enclosingFunctionName(node)}|${target}|${destination}`);
      }
      if (
        (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))
        && (
          URL_BEARING_ATTRIBUTES.has((resolvedPropertyName(left, bindings) ?? "").toLowerCase())
          || HTML_INJECTION_PROPERTIES.has(resolvedPropertyName(left, bindings) ?? "")
        )
      ) {
        resources.push(`${file}|dom-assignment|${normalizedSource(node.right, sourceFile)}`);
      }
    }

    const moduleValue = importModuleValue(node, bindings);
    if (moduleValue !== null && isAnalyticsModule(moduleValue)) {
      addFinding(findings, sourceFile, node, "ANALYTICS_SDK_IMPORT", moduleValue);
    }
    if (moduleValue !== null && DANGEROUS_EXECUTION_MODULE_RE.test(moduleValue)) {
      addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", `execution module ${moduleValue}`);
    }
    if (moduleValue !== null && /^(?:blob|data|https?):/iu.test(moduleValue)) {
      addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", `remote/data module ${moduleValue.slice(0, 80)}`);
    }
    if (
      moduleValue !== null
      && TEST_PATH_RE.test(moduleValue)
      && !isApprovedDistImport(file, moduleValue)
    ) {
      addFinding(findings, sourceFile, node, "TEST_CODE_IMPORT", moduleValue);
    }

    if (ts.isTaggedTemplateExpression(node)) {
      if (isNetworkReference(node.tag, networkTainted, bindings)) {
        sinks.push(
          `${file}|${enclosingFunctionName(node)}|${normalizedSource(node.tag, sourceFile)}|${normalizedSource(node.template, sourceFile)}`,
        );
      }
      if (isDynamicExecutionReference(node.tag, dynamicTainted, bindings)) {
        addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", "dynamic execution tagged template");
      }
    }

    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      resources.push(...reactCreateElementResources(file, node, sourceFile, bindings));
      if (isModuleLoaderCall(node, bindings) && staticText(node.arguments[0], bindings) === null) {
        addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", "non-literal module load");
      }
      if (isDynamicExecutionReference(expression, dynamicTainted, bindings)) {
        addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", `${normalizedSource(expression, sourceFile)}()`);
      }
      if (
        normalizedSource(expression, sourceFile) === "Reflect.apply"
        && node.arguments[0]
        && isDynamicExecutionReference(node.arguments[0], dynamicTainted, bindings)
      ) {
        addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", "Reflect.apply(dynamic execution primitive)");
      }
      const timerCallback = timerCallbackArgument(node, bindings);
      if (timerCallback && !isProvablyCallable(timerCallback, bindings, syntacticCallables)) {
        addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", `${normalizedSource(expression, sourceFile)}(non-callable)`);
      }
      if (
        (ts.isIdentifier(expression) && expression.text === "createRequire")
        || normalizedSource(expression, sourceFile) === "module.createRequire"
      ) {
        addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", "createRequire()");
      }
      if (
        normalizedSource(expression, sourceFile) === "Object.defineProperty"
        && node.arguments.length >= 2
      ) {
        const receiverValue = normalizedSource(node.arguments[0], sourceFile);
        const key = staticText(node.arguments[1], bindings);
        if (
          ["globalThis", "navigator", "self", "window"].includes(receiverValue)
          && NETWORK_GLOBAL_MEMBER_NAMES.has(key ?? "")
        ) {
          addFinding(findings, sourceFile, node, "NETWORK_MUTATION", `${receiverValue}.${key}`);
        }
      }
      if (
        ["Object.assign", "Object.defineProperties"].includes(normalizedSource(expression, sourceFile))
        && node.arguments.length >= 2
        && ["globalThis", "navigator", "self", "window"].includes(normalizedSource(node.arguments[0], sourceFile))
      ) {
        const properties = unwrapExpression(node.arguments[1]);
        if (
          ts.isObjectLiteralExpression(properties)
          && properties.properties.some((property) => {
            if (!property.name) return false;
            return NETWORK_GLOBAL_MEMBER_NAMES.has(staticPropertyKey(property.name, bindings) ?? "");
          })
        ) {
          addFinding(findings, sourceFile, node, "NETWORK_MUTATION", normalizedSource(expression, sourceFile));
        }
      }
      if (
        normalizedSource(expression, sourceFile) === "Reflect.set"
        && node.arguments.length >= 2
        && ["globalThis", "navigator", "self", "window"].includes(normalizedSource(node.arguments[0], sourceFile))
        && NETWORK_GLOBAL_MEMBER_NAMES.has(staticText(node.arguments[1], bindings) ?? "")
      ) {
        addFinding(findings, sourceFile, node, "NETWORK_MUTATION", "Reflect.set network primitive");
      }
      if (
        normalizedSource(expression, sourceFile) === "Reflect.get"
        && node.arguments[1]
        && isAnalyticsConfigIdentifier(staticText(node.arguments[1], bindings) ?? "")
      ) {
        addFinding(findings, sourceFile, node, "ANALYTICS_CONFIG", staticText(node.arguments[1], bindings));
      }
      if (
        (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
        && /^(?:globalThis\.|window\.)?WebAssembly$/u.test(normalizedSource(receiverExpression(expression), sourceFile))
        && ["compile", "instantiate", "instantiateStreaming"].includes(resolvedPropertyName(expression, bindings) ?? "")
      ) {
        addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", normalizedSource(expression, sourceFile));
      }
      if (ts.isIdentifier(expression) && BARE_EMITTER_RE.test(expression.text)) {
        addFinding(findings, sourceFile, expression, "ANALYTICS_EMITTER", expression.text);
      }
      const method = resolvedPropertyName(expression, bindings);
      const receiver = receiverExpression(expression);
      const receiverName = receiver && ts.isIdentifier(unwrapExpression(receiver))
        ? unwrapExpression(receiver).text
        : null;
      if (method && HTML_INJECTION_METHODS.has(method)) {
        const payloadIndex = method === "insertAdjacentHTML" ? 1 : 0;
        const payload = node.arguments[payloadIndex];
        resources.push(
          `${file}|dom-${method}|${payload ? normalizedSource(payload, sourceFile) : "<missing>"}`,
        );
      }
      if (["setAttribute", "setAttributeNS"].includes(method ?? "")) {
        const nameIndex = method === "setAttributeNS" ? 1 : 0;
        const valueIndex = method === "setAttributeNS" ? 2 : 1;
        const attributeName = staticText(node.arguments[nameIndex], bindings)?.toLowerCase() ?? null;
        if (
          attributeName === null
          || URL_BEARING_ATTRIBUTES.has(attributeName)
          || HTML_INJECTION_PROPERTIES.has(attributeName)
          || attributeName === "style"
          || attributeName.startsWith("on")
        ) {
          const payload = node.arguments[valueIndex];
          resources.push(
            `${file}|dom-${method}|${payload ? normalizedSource(payload, sourceFile) : "<missing>"}`,
          );
        }
      }
      const dottedMethod = method === "set" && receiver && ts.isPropertyAccessExpression(receiver)
        ? `${receiver.name.text}.set`
        : method;
      if (receiver && expressionLooksAnalytics(receiver, tainted, bindings)) {
        addFinding(findings, sourceFile, node, "ANALYTICS_EMITTER", normalizedSource(expression, sourceFile));
      }
      if (
        dottedMethod
        && EMITTER_METHODS.includes(dottedMethod)
        && (expressionLooksAnalytics(expression, tainted, bindings) || (receiverName && ANALYTICS_RECEIVER_RE.test(receiverName)))
      ) {
        addFinding(findings, sourceFile, node, "ANALYTICS_EMITTER", normalizedSource(expression, sourceFile));
      }
      if (ts.isIdentifier(expression) && tainted.has(expression.text)) {
        addFinding(findings, sourceFile, node, "ANALYTICS_EMITTER", `${expression.text}()`);
      }

      const callMethod = resolvedPropertyName(expression, bindings);
      if (
        (callMethod && REQUESTISH_METHODS.has(callMethod))
        || (ts.isIdentifier(expression) && expression.text === "fetch")
      ) {
        for (const argument of node.arguments) {
          const value = staticText(argument, bindings);
          if (value === null) continue;
          const reason = providerEndpointReason(value) ?? analyticsRouteReason(value);
          if (reason) addFinding(findings, sourceFile, argument, "ANALYTICS_ENDPOINT", reason);
        }
      }

      const networkCall = isNetworkCall(node, networkTainted, bindings);
      if (networkCall) {
        sinks.push(sinkFingerprint(file, node, sourceFile, bindings));
      } else {
        for (const argument of node.arguments) {
          if (isNetworkReference(argument, networkTainted, bindings)) {
            addFinding(
              findings,
              sourceFile,
              argument,
              "NETWORK_PRIMITIVE_ESCAPE",
              `network primitive passed to ${normalizedSource(expression, sourceFile)}`,
            );
          }
        }
      }

      const domTag = domResourceTag(node, sourceFile, bindings);
      if (domTag) {
        resources.push(`${file}|dom-${domTag}|<created>`);
      }
    }

    if (ts.isNewExpression(node)) {
      const callee = normalizedSource(node.expression, sourceFile);
      if (/^(?:PostHog|Posthog)$/u.test(callee) || tainted.has(callee)) {
        addFinding(findings, sourceFile, node, "ANALYTICS_EMITTER", `new ${callee}`);
      }
      if (isDynamicExecutionReference(node.expression, dynamicTainted, bindings)) {
        addFinding(findings, sourceFile, node, "DYNAMIC_EXECUTION", `new ${callee}()`);
      }
      if (isNetworkConstructor(node, networkTainted, bindings)) {
        const target = sinkTarget(node, bindings);
        const value = staticText(target, bindings);
        const reason = value === null ? null : providerEndpointReason(value) ?? analyticsRouteReason(value);
        if (reason && target) addFinding(findings, sourceFile, target, "ANALYTICS_ENDPOINT", reason);
        sinks.push(sinkFingerprint(file, node, sourceFile, bindings));
      }
      const redirectTarget = redirectHeaderTarget(node, bindings);
      if (redirectTarget) {
        sinks.push(
          `${file}|${enclosingFunctionName(node)}|${callee}.Location|${normalizedSource(redirectTarget, sourceFile)}`,
        );
      }
    }

    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isBinaryExpression(node)) {
      const value = staticText(node, bindings);
      const reason = value === null ? null : providerEndpointReason(value);
      if (reason && !isProviderDisclosureNode(node, bindings)) {
        addFinding(findings, sourceFile, node, "ANALYTICS_ENDPOINT", reason);
      }
    }

    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);

  if (!embedded) {
    for (const { node, text } of htmlFragments(sourceFile, bindings)) {
      for (const fingerprint of embeddedResources(file, text)) resources.push(fingerprint);
      const endpointReason = providerEndpointReason(text) ?? analyticsRouteReason(text);
      if (endpointReason && !isProviderDisclosureNode(node, bindings)) {
        addFinding(findings, sourceFile, node, "ANALYTICS_ENDPOINT", endpointReason);
      }
      for (const script of inlineScripts(text)) {
        const nested = analyzeCode(`${file}#inline-script`, script, { embedded: true });
        findings.push(...nested.findings);
        sinks.push(...nested.sinks);
      }
      for (const handler of inlineEventHandlers(text)) {
        const nested = analyzeCode(`${file}#inline-handler`, handler, { embedded: true });
        findings.push(...nested.findings);
        sinks.push(...nested.sinks);
      }
      for (const document of embeddedDocuments(text)) {
        const nested = analyzeCode(
          `${file}#srcdoc`,
          `const html = ${JSON.stringify(document)};`,
        );
        findings.push(...nested.findings);
        sinks.push(...nested.sinks);
        resources.push(...nested.resources);
      }
    }
  }

  return { findings: deduplicateFindings(findings), sinks, resources };
}

function inspectJson(file, source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return [{ file, line: 1, column: 1, code: "PARSE_ERROR", detail: `invalid JSON: ${error.message}` }];
  }
  const findings = [];
  const visit = (current, key = "", ancestors = []) => {
    const path = [...ancestors, key].filter(Boolean);
    const compositeKey = path.join("_");
    if (isAnalyticsConfigIdentifier(key) || isAnalyticsConfigIdentifier(compositeKey)) {
      findings.push({ file, line: 1, column: 1, code: "ANALYTICS_CONFIG", detail: compositeKey || key });
    }
    if (typeof current === "string") {
      const reason = providerEndpointReason(current);
      const disclosureUrl = path.some((part) => DISCLOSURE_NAME_RE.test(part))
        && /https?:\/\/(?:[a-z0-9-]+\.)*posthog\.com\/(?:docs|legal|privacy)(?:[/?#]|$)/iu.test(current)
        && !analyticsRouteReason(current);
      if (reason && !disclosureUrl) {
        findings.push({ file, line: 1, column: 1, code: "ANALYTICS_ENDPOINT", detail: reason });
      }
    } else if (Array.isArray(current)) {
      for (const item of current) visit(item, "", path);
    } else if (current && typeof current === "object") {
      for (const [childKey, child] of Object.entries(current)) visit(child, childKey, path);
    }
  };
  visit(value);
  return findings;
}

export function analyzeManifest(file, source) {
  const findings = inspectJson(file, source);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return findings;
  }
  const dependencySections = [
    value.dependencies,
    value.devDependencies,
    value.optionalDependencies,
    value.peerDependencies,
  ];
  for (const section of dependencySections) {
    for (const [name, spec] of Object.entries(section ?? {})) {
      if (isAnalyticsModule(name)) {
        findings.push({ file, line: 1, column: 1, code: "ANALYTICS_SDK_DEPENDENCY", detail: name });
      }
      if (typeof spec === "string" && spec.startsWith("npm:")) {
        const alias = /^npm:(@[^/]+\/[^@]+|[^@]+)(?:@|$)/u.exec(spec)?.[1] ?? null;
        if (alias && isAnalyticsModule(alias)) {
          findings.push({ file, line: 1, column: 1, code: "ANALYTICS_SDK_DEPENDENCY", detail: `${name} -> ${alias}` });
        }
      }
      if (typeof spec === "string" && analyticsModuleInLocator(spec)) {
        findings.push({ file, line: 1, column: 1, code: "ANALYTICS_SDK_DEPENDENCY", detail: `${name} -> ${spec}` });
      }
    }
  }
  for (const [packagePath, record] of Object.entries(value.packages ?? {})) {
    const pathName = packagePath.includes("node_modules/")
      ? packagePath.split("node_modules/").at(-1)
      : packagePath;
    const recordName = record && typeof record === "object" && typeof record.name === "string"
      ? record.name
      : null;
    for (const name of [pathName, recordName]) {
      if (name && isAnalyticsModule(name)) {
        findings.push({ file, line: 1, column: 1, code: "ANALYTICS_SDK_DEPENDENCY", detail: name });
      }
    }
    if (record && typeof record === "object" && typeof record.resolved === "string" && analyticsModuleInLocator(record.resolved)) {
      findings.push({
        file,
        line: 1,
        column: 1,
        code: "ANALYTICS_SDK_DEPENDENCY",
        detail: `${packagePath} -> ${record.resolved}`,
      });
    }
  }
  if (file.endsWith("package.json")) {
    const expectedScriptsHash = APPROVED_PACKAGE_SCRIPT_HASHES[file] ?? sha256(stableJson({}));
    const actualScriptsHash = sha256(stableJson(value.scripts ?? {}));
    if (actualScriptsHash !== expectedScriptsHash) {
      findings.push({
        file,
        line: 1,
        column: 1,
        code: "PACKAGE_SCRIPT_DRIFT",
        detail: `expected ${expectedScriptsHash}, found ${actualScriptsHash}`,
      });
    }
    const expectedRuntime = APPROVED_PACKAGE_RUNTIME_METADATA[file]
      ?? {
        main: null,
        type: null,
        bin: null,
        browser: null,
        bundleDependencies: null,
        bundledDependencies: null,
        exports: null,
        files: null,
        imports: null,
        module: null,
        workspaces: null,
      };
    const actualRuntime = {
      main: value.main ?? null,
      type: value.type ?? null,
      bin: value.bin ?? null,
      browser: value.browser ?? null,
      bundleDependencies: value.bundleDependencies ?? null,
      bundledDependencies: value.bundledDependencies ?? null,
      exports: value.exports ?? null,
      files: value.files ?? null,
      imports: value.imports ?? null,
      module: value.module ?? null,
      workspaces: value.workspaces ?? null,
    };
    if (stableJson(actualRuntime) !== stableJson(expectedRuntime)) {
      findings.push({
        file,
        line: 1,
        column: 1,
        code: "RUNTIME_ENTRYPOINT_DRIFT",
        detail: `expected ${stableJson(expectedRuntime)}, found ${stableJson(actualRuntime)}`,
      });
    }
    const emptyDependencies = {
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {},
      overrides: {},
      peerDependencies: {},
      resolutions: {},
    };
    const expectedDependencies = APPROVED_PACKAGE_DEPENDENCIES[file] ?? emptyDependencies;
    const actualDependencies = Object.fromEntries(
      Object.keys(emptyDependencies).map((name) => [name, value[name] ?? {}]),
    );
    if (stableJson(actualDependencies) !== stableJson(expectedDependencies)) {
      findings.push({
        file,
        line: 1,
        column: 1,
        code: "DEPENDENCY_INVENTORY_DRIFT",
        detail: `expected ${stableJson(expectedDependencies)}, found ${stableJson(actualDependencies)}`,
      });
    }
  }
  const lifecycleNames = ["preinstall", "install", "postinstall", "prepare"];
  for (const name of lifecycleNames) {
    const actual = value.scripts?.[name];
    const approved = file === "package.json" ? APPROVED_LIFECYCLE_SCRIPTS[name] : undefined;
    if (actual !== approved) {
      findings.push({
        file,
        line: 1,
        column: 1,
        code: "LIFECYCLE_SCRIPT_DRIFT",
        detail: `${name} — expected ${JSON.stringify(approved)}, found ${JSON.stringify(actual)}`,
      });
    }
  }
  return findings;
}

export function inspectToml(file, source) {
  const findings = [];
  let code = "";
  let inComment = false;
  let commentQuote = null;
  let commentEscaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inComment) {
      if (char === "\n" || char === "\r") {
        inComment = false;
        code += char;
      } else {
        code += " ";
      }
      continue;
    }
    if (commentQuote) {
      code += char;
      if (commentEscaped) commentEscaped = false;
      else if (char === "\\" && commentQuote === '\"') commentEscaped = true;
      else if (char === commentQuote) commentQuote = null;
      continue;
    }
    if (char === '\"' || char === "'") {
      commentQuote = char;
      code += char;
    } else if (char === "#") {
      inComment = true;
      code += " ";
    } else {
      code += char;
    }
  }

  let brackets = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\" && quote === '"') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    if (brackets < 0) break;
  }
  if (quote || brackets !== 0) {
    findings.push({ file, line: 1, column: 1, code: "PARSE_ERROR", detail: "unbalanced TOML quote/bracket" });
  }
  const keyRe = /^\s*([A-Za-z0-9_."'-]+)\s*=/gmu;
  for (const match of code.matchAll(keyRe)) {
    const key = match[1].replace(/["']/gu, "");
    if (isAnalyticsConfigIdentifier(key)) {
      findings.push({ file, line: 1, column: 1, code: "ANALYTICS_CONFIG", detail: key });
    }
  }
  const workerMains = [...code.matchAll(/^\s*main\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/gimu)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "");
  const expectedMain = APPROVED_WORKER_MAINS[file];
  if (workerMains.length > 0 || expectedMain !== undefined) {
    if (workerMains.length !== 1 || workerMains[0] !== expectedMain) {
      findings.push({
        file,
        line: 1,
        column: 1,
        code: "WORKER_ENTRYPOINT_DRIFT",
        detail: `expected ${JSON.stringify(expectedMain)}, found ${JSON.stringify(workerMains)}`,
      });
    }
    if (workerMains.some((entry) => TEST_PATH_RE.test(entry) || /(?:^|\/)(?:dist|\.wrangler)(?:\/|$)/u.test(entry))) {
      findings.push({ file, line: 1, column: 1, code: "TEST_CODE_IMPORT", detail: `Worker main ${workerMains.join(", ")}` });
    }
  }
  const telemetry = {};
  let table = "";
  for (const line of code.split(/\r?\n/u)) {
    const tableMatch = line.match(/^\s*\[\s*([^\[\]]+?)\s*\]\s*$/u);
    if (tableMatch) {
      table = tableMatch[1].replace(/["']/gu, "").trim();
      continue;
    }
    const assignment = line.match(/^\s*([A-Za-z0-9_."'-]+)\s*=\s*(.*?)\s*$/u);
    if (!assignment) continue;
    const key = assignment[1].replace(/["']/gu, "");
    if (table === "observability" && key === "enabled") {
      telemetry[`${file}|cloudflare-observability`] = assignment[2] === "true"
        ? "enabled"
        : `unexpected:${assignment[2]}`;
    }
  }
  const telemetryKeys = new Set([
    ...Object.keys(telemetry),
    ...Object.keys(APPROVED_PLATFORM_TELEMETRY).filter((key) => key.startsWith(`${file}|`)),
  ]);
  for (const key of telemetryKeys) {
    const actual = telemetry[key];
    const expected = APPROVED_PLATFORM_TELEMETRY[key];
    if (actual !== expected) {
      findings.push({
        file,
        line: 1,
        column: 1,
        code: "PLATFORM_TELEMETRY_DRIFT",
        detail: `${key} — expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
      });
    }
  }

  const endpointReason = providerEndpointReason(code);
  if (endpointReason) {
    findings.push({ file, line: 1, column: 1, code: "ANALYTICS_ENDPOINT", detail: endpointReason });
  }
  return findings;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function compareInventory(actualItems, approvedObject, code) {
  const findings = [];
  const actual = new Map();
  for (const item of actualItems) increment(actual, item);
  const keys = new Set([...actual.keys(), ...Object.keys(approvedObject)]);
  for (const key of [...keys].sort()) {
    const actualCount = actual.get(key) ?? 0;
    const approvedCount = approvedObject[key] ?? 0;
    if (actualCount !== approvedCount) {
      findings.push({
        file: key.split("|")[0],
        line: 1,
        column: 1,
        code,
        detail: `${key} — expected ${approvedCount}, found ${actualCount}`,
      });
    }
  }
  return findings;
}

function readEntries(directory, findings, files) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    findings.push({ file: directory, line: 1, column: 1, code: "READ_ERROR", detail: error.message });
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORY_SET.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      findings.push({ file: full, line: 1, column: 1, code: "UNSUPPORTED_FILE", detail: "symbolic link" });
    } else if (entry.isDirectory()) {
      readEntries(full, findings, files);
    } else if (entry.isFile()) {
      files.push(full);
    } else {
      findings.push({ file: full, line: 1, column: 1, code: "UNSUPPORTED_FILE", detail: "non-regular file" });
    }
  }
}

export function scanRepository(root) {
  const absoluteRoot = resolve(root);
  const findings = [];
  const files = [];
  for (const rootName of SCAN_ROOTS) {
    const scanRoot = join(absoluteRoot, rootName);
    try {
      const stat = lstatSync(scanRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        findings.push({
          file: rootName,
          line: 1,
          column: 1,
          code: "UNSUPPORTED_FILE",
          detail: stat.isSymbolicLink() ? "scan root is a symbolic link" : "scan root is not a directory",
        });
        continue;
      }
      readEntries(scanRoot, findings, files);
    } catch (error) {
      findings.push({ file: rootName, line: 1, column: 1, code: "READ_ERROR", detail: error.message });
    }
  }
  for (const relativeFile of FORBIDDEN_REPOSITORY_FILES) {
    try {
      lstatSync(join(absoluteRoot, relativeFile));
      findings.push({
        file: relativeFile,
        line: 1,
        column: 1,
        code: "ALTERNATIVE_CONFIG",
        detail: "unreviewed alternative install/deployment configuration",
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        findings.push({ file: relativeFile, line: 1, column: 1, code: "READ_ERROR", detail: error.message });
      }
    }
  }
  for (const relativeFile of EXTRA_RUNTIME_FILES) {
    const full = join(absoluteRoot, relativeFile);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        findings.push({ file: relativeFile, line: 1, column: 1, code: "UNSUPPORTED_FILE", detail: "symbolic link" });
      } else if (!stat.isFile()) {
        findings.push({ file: relativeFile, line: 1, column: 1, code: "UNSUPPORTED_FILE", detail: "non-regular file" });
      } else {
        files.push(full);
      }
    } catch (error) {
      findings.push({ file: relativeFile, line: 1, column: 1, code: "READ_ERROR", detail: error.message });
    }
  }
  for (const [relativeFile, expected] of Object.entries(APPROVED_PUBLISHED_FILE_HASHES)) {
    const full = join(absoluteRoot, relativeFile);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        findings.push({
          file: relativeFile,
          line: 1,
          column: 1,
          code: "PUBLISHED_ASSET_DRIFT",
          detail: stat.isSymbolicLink() ? "symbolic link" : "non-regular file",
        });
        continue;
      }
      const actual = createHash("sha256").update(readFileSync(full)).digest("hex");
      if (actual !== expected) {
        findings.push({
          file: relativeFile,
          line: 1,
          column: 1,
          code: "PUBLISHED_ASSET_DRIFT",
          detail: `expected ${expected}, found ${actual}`,
        });
      }
    } catch (error) {
      findings.push({ file: relativeFile, line: 1, column: 1, code: "READ_ERROR", detail: error.message });
    }
  }
  for (const [relativeFile, expected] of Object.entries(APPROVED_OPERATIONAL_FILE_HASHES)) {
    const full = join(absoluteRoot, relativeFile);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        findings.push({
          file: relativeFile,
          line: 1,
          column: 1,
          code: "OPERATIONAL_FILE_DRIFT",
          detail: stat.isSymbolicLink() ? "symbolic link" : "non-regular file",
        });
        continue;
      }
      const actual = createHash("sha256").update(readFileSync(full)).digest("hex");
      if (actual !== expected) {
        findings.push({
          file: relativeFile,
          line: 1,
          column: 1,
          code: "OPERATIONAL_FILE_DRIFT",
          detail: `expected ${expected}, found ${actual}`,
        });
      }
    } catch (error) {
      findings.push({ file: relativeFile, line: 1, column: 1, code: "READ_ERROR", detail: error.message });
    }
  }
  for (const [relativeFile, expected] of Object.entries(APPROVED_REVIEW_FILE_HASHES)) {
    const full = join(absoluteRoot, relativeFile);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        findings.push({
          file: relativeFile,
          line: 1,
          column: 1,
          code: "REVIEW_ARTIFACT_DRIFT",
          detail: stat.isSymbolicLink() ? "symbolic link" : "non-regular file",
        });
        continue;
      }
      const actual = createHash("sha256").update(readFileSync(full)).digest("hex");
      if (actual !== expected) {
        findings.push({
          file: relativeFile,
          line: 1,
          column: 1,
          code: "REVIEW_ARTIFACT_DRIFT",
          detail: `expected ${expected}, found ${actual}`,
        });
      }
    } catch (error) {
      findings.push({ file: relativeFile, line: 1, column: 1, code: "READ_ERROR", detail: error.message });
    }
  }

  const sinks = [];
  const resources = [];
  let codeFileCount = 0;
  for (const file of files.sort()) {
    const rel = relative(absoluteRoot, file).replaceAll("\\", "/");
    if (TEST_FILE_RE.test(rel)) continue;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      findings.push({ file: rel, line: 1, column: 1, code: "READ_ERROR", detail: error.message });
      continue;
    }
    findings.push(...compareLockfileHash(rel, source));
    findings.push(...compareConfigFileHash(rel, source));
    const extension = extname(file).toLowerCase();
    if (CODE_EXTENSION_SET.has(extension)) {
      codeFileCount += 1;
      const result = analyzeCode(rel, source);
      findings.push(...result.findings);
      findings.push(...compareFrozenSource(rel, source));
      sinks.push(...result.sinks);
      resources.push(...result.resources);
    } else if (file.endsWith("package.json") || file.endsWith("package-lock.json")) {
      findings.push(...analyzeManifest(rel, source));
    } else if (extension === ".json") {
      findings.push(...inspectJson(rel, source));
    } else if (extension === ".toml") {
      findings.push(...inspectToml(rel, source));
    } else if (entryIsAllowedNonExecutable(file)) {
      // Explicitly inert repository metadata.
    } else {
      let executable = false;
      try {
        executable = (lstatSync(file).mode & 0o111) !== 0 || source.startsWith("#!");
      } catch {
        executable = true;
      }
      findings.push({
        file: rel,
        line: 1,
        column: 1,
        code: "UNSUPPORTED_FILE",
        detail: executable ? "unknown executable file" : `unreviewed file extension ${extension || "<none>"}`,
      });
    }
  }

  for (const name of ["package.json", "package-lock.json"]) {
    const file = join(absoluteRoot, name);
    try {
      const source = readFileSync(file, "utf8");
      findings.push(...compareLockfileHash(name, source));
      findings.push(...analyzeManifest(name, source));
    } catch (error) {
      findings.push({ file: name, line: 1, column: 1, code: "READ_ERROR", detail: error.message });
    }
  }

  findings.push(...compareInventory(sinks, APPROVED_NETWORK_SINKS, "NETWORK_SINK_DRIFT"));
  findings.push(...compareInventory(resources, APPROVED_EMBEDDED_RESOURCES, "EMBEDDED_RESOURCE_DRIFT"));
  const sinkSourceOwners = new Set(sinks.map((sink) => sink.split("|")[0].split("#")[0]));
  for (const owner of [...sinkSourceOwners].sort()) {
    if (!Object.hasOwn(APPROVED_SOURCE_FILE_HASHES, owner)) {
      findings.push({
        file: owner,
        line: 1,
        column: 1,
        code: "UNFROZEN_SINK_SOURCE",
        detail: "network sink owner lacks a full reviewed source hash",
      });
    }
  }
  return { findings: deduplicateFindings(findings), sinks, resources, codeFileCount };
}

export function scanBuiltArtifacts(root) {
  const absoluteRoot = resolve(root);
  const distRoot = join(absoluteRoot, "dist");
  const findings = [];
  const files = [];
  try {
    const stat = lstatSync(distRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      findings.push({
        file: "dist",
        line: 1,
        column: 1,
        code: "UNSUPPORTED_FILE",
        detail: stat.isSymbolicLink() ? "build root is a symbolic link" : "build root is not a directory",
      });
    } else {
      readEntries(distRoot, findings, files);
    }
  } catch (error) {
    findings.push({ file: "dist", line: 1, column: 1, code: "READ_ERROR", detail: error.message });
  }

  const sinks = [];
  const resources = [];
  let codeFileCount = 0;
  for (const file of files.sort()) {
    const rel = relative(absoluteRoot, file).replaceAll("\\", "/");
    if (file.endsWith(".map") || file.endsWith(".d.ts")) continue;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      findings.push({ file: rel, line: 1, column: 1, code: "READ_ERROR", detail: error.message });
      continue;
    }
    if (![".cjs", ".js", ".mjs"].includes(extname(file).toLowerCase())) {
      findings.push({
        file: rel,
        line: 1,
        column: 1,
        code: "UNSUPPORTED_FILE",
        detail: `unreviewed built file extension ${extname(file) || "<none>"}`,
      });
      continue;
    }
    codeFileCount += 1;
    const result = analyzeCode(rel, source);
    findings.push(...result.findings);
    sinks.push(...result.sinks);
    resources.push(...result.resources);
  }
  findings.push(...compareInventory(sinks, APPROVED_BUILT_NETWORK_SINKS, "BUILT_NETWORK_SINK_DRIFT"));
  findings.push(...compareInventory(resources, {}, "BUILT_EMBEDDED_RESOURCE_DRIFT"));
  return { findings: deduplicateFindings(findings), sinks, resources, codeFileCount };
}

function entryIsAllowedNonExecutable(file) {
  return file.endsWith("/.gitignore");
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const built = process.argv.includes("--built");
  const result = built ? scanBuiltArtifacts(root) : scanRepository(root);
  if (process.argv.includes("--print-inventory")) {
    console.log(JSON.stringify({ sinks: result.sinks.sort(), resources: result.resources.sort() }, null, 2));
  }
  if (result.findings.length > 0) {
    console.error(`ERROR: analytics emitter gate found ${result.findings.length} violation(s).`);
    for (const finding of result.findings) {
      console.error(`  - ${finding.file}:${finding.line}:${finding.column} [${finding.code}] ${finding.detail}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Analytics emitter gate (${built ? "built artifacts" : "source"}): OK — ${result.codeFileCount} runtime files; ${result.sinks.length} approved network sinks; ${result.resources.length} approved embedded resources. Prose disclosures are allowed.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
