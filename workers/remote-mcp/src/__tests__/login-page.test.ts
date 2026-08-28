import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { getLoginPage } from "../login-page.ts";

const openAIProfileSource = readFileSync(
  fileURLToPath(new URL("../../../../src/openai-profile.ts", import.meta.url)),
  "utf8",
);

const baseOptions = {
  stateKey: "state_test",
  clientId: "client_test",
  firebaseProjectId: "project_test",
  clientName: "Official Test Client",
  redirectUri: "https://chatgpt.com/oauth/callback",
};

describe("OAuth consent copy", () => {
  test("OpenAI deployment describes only the reviewed connector surface", () => {
    const html = getLoginPage({ ...baseOptions, accessProfile: "openai" });

    assert.match(html, /self-declared OAuth client/);
    assert.match(html, /Official Test Client/);
    assert.match(html, /chatgpt\.com/);
    assert.match(html, /Current business context/);
    assert.match(html, /monthly invoice usage/);
    assert.match(html, /PostHog's EU-hosted analytics service/);
    assert.match(html, /Ten confirmed writes may deliver one or more full business events/);
    assert.match(html, /outside the reviewed ChatGPT response schema/);
    assert.match(html, /complete underlying record/);
    assert.match(html, /may notify eligible workspace admins or accountants/);
    assert.match(html, /Novu/);
    assert.match(html, /quote-email delivery/);
    assert.match(html, /Updating an existing quote, deleting an expense/);
    assert.match(html, /deleting a product/);
    assert.match(html, /clean draft with no delivery, response, attachment, or conversion evidence/);
    assert.match(html, /protected draft is refused and left unchanged/);
    assert.match(html, /deleting a non-draft quote cancels it/);
    assert.match(html, /expense updates cannot change amount or supplier identity/);
    assert.match(html, /new vendor is needed, its separate creation step may persist even if the later expense write fails/);
    assert.match(html, /existing identity and contact details internally/);
    assert.doesNotMatch(html, /Updating a quote cannot set lifecycle status/);
    assert.doesNotMatch(html, /Deleting an expense changes internal accounting/);
    assert.match(html, /has no dedicated fields for government or banking identifiers/);
    assert.match(html, /https:\/\/openai-mcp\.frihet\.io\/privacy/);
    assert.match(html, /https:\/\/openai-mcp\.frihet\.io\/support/);
    assert.doesNotMatch(html, /near-complete access to your account/);
    assert.doesNotMatch(html, /Tax &amp; fiscal reports/);
    assert.doesNotMatch(html, /Gestoría, general-ledger entries and portal settings/);
    assert.doesNotMatch(html, /Send invoices|manage webhook configurations|credit note/i);
  });

  test("client-controlled consent labels are escaped and cannot inject markup", () => {
    const html = getLoginPage({
      ...baseOptions,
      accessProfile: "openai",
      clientName: '<img src=x onerror="alert(1)">',
      redirectUri: "https://example.com/oauth/callback",
    });

    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /<code>https:\/\/example\.com<\/code>/);
  });

  test("credential fields and external links carry safe browser metadata", () => {
    const html = getLoginPage({ ...baseOptions, accessProfile: "openai" });

    assert.match(html, /id="email" name="email"[^>]*autocomplete="email"/u);
    assert.match(html, /id="password" name="password"[^>]*autocomplete="current-password"/u);
    assert.equal(
      (html.match(/target="_blank" rel="noopener noreferrer"/gu) ?? []).length,
      2,
    );
  });

  test("Firebase auth helper origin is allowed by both frame and connection CSP", () => {
    assert.match(
      openAIProfileSource,
      /"connect-src[^;]*[\s\S]*?https:\/\/auth\.frihet\.io[^;]*; "/u,
    );
    assert.match(
      openAIProfileSource,
      /"frame-src https:\/\/auth\.frihet\.io[^;]*; "/u,
    );
  });

  test("reviewed login CSP has no scheme wildcard or unrelated service origins", () => {
    assert.match(openAIProfileSource, /"base-uri 'none'; "/u);
    assert.match(openAIProfileSource, /"object-src 'none'; "/u);
    assert.match(openAIProfileSource, /"frame-ancestors 'none'; "/u);
    assert.match(openAIProfileSource, /"img-src 'self' data:; "/u);
    assert.match(openAIProfileSource, /"font-src 'self'"/u);
    assert.doesNotMatch(openAIProfileSource, /img-src[^;]*https:/u);
    assert.doesNotMatch(openAIProfileSource, /connect-src[^;]*api\.frihet\.io/u);
    assert.doesNotMatch(openAIProfileSource, /connect-src[^;]*cloudfunctions\.net/u);
    assert.doesNotMatch(openAIProfileSource, /connect-src[^;]*www\.gstatic\.com/u);
    assert.doesNotMatch(openAIProfileSource, /font-src[^;]*www\.frihet\.io/u);
  });

  test("full deployment preserves its existing broad-access disclosure", () => {
    const html = getLoginPage({ ...baseOptions, accessProfile: "full" });

    assert.match(html, /full access to manage your Frihet account/);
    assert.match(html, /Banking, transactions and reconciliation/);
    assert.match(html, /near-complete access to your account/);
    assert.doesNotMatch(html, /self-declared OAuth client/);
  });
});
