import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getLoginPage } from "../login-page.ts";

const baseOptions = {
  stateKey: "state_test",
  clientId: "client_test",
  firebaseProjectId: "project_test",
};

describe("OAuth consent copy", () => {
  test("OpenAI deployment describes only the reviewed connector surface", () => {
    const html = getLoginPage({ ...baseOptions, accessProfile: "openai" });

    assert.match(html, /ChatGPT wants access to the reviewed Frihet business-management tools/);
    assert.match(html, /Monthly business context and summaries/);
    assert.match(html, /Send invoices or quotes to saved client email addresses/);
    assert.match(html, /does not expose government identifiers/);
    assert.match(html, /"useRedirectAuth":true/);
    assert.match(html, /signInWithRedirect\(authProvider\)/);
    assert.match(html, /getRedirectResult\(\)/);
    assert.doesNotMatch(html, /near-complete access to your account/);
    assert.doesNotMatch(html, /Tax &amp; fiscal reports/);
    assert.doesNotMatch(html, /Gestoría, general-ledger entries and portal settings/);
  });

  test("full deployment preserves its existing broad-access disclosure", () => {
    const html = getLoginPage({ ...baseOptions, accessProfile: "full" });

    assert.match(html, /full access to manage your Frihet account/);
    assert.match(html, /Banking, transactions and reconciliation/);
    assert.match(html, /near-complete access to your account/);
    assert.match(html, /"useRedirectAuth":false/);
    assert.match(html, /signInWithPopup\(authProvider\)/);
    assert.doesNotMatch(html, /ChatGPT wants access to the reviewed Frihet/);
  });
});
