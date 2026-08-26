/**
 * Anti-defang gate for the conformance provenance mask.
 *
 * Masking fields before a comparison is exactly how a gate gets quietly
 * neutered: widen the list far enough and `--check` passes on anything. These
 * tests pin the list to the one field that is genuinely identity-not-result,
 * and prove that every category the gate exists to catch still turns it red.
 *
 * Run: node --test scripts/__tests__/conformance-provenance.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PROVENANCE_POINTERS,
  compareIgnoringProvenance,
  maskProvenance,
  readPointer,
} from "../conformance/provenance.mjs";

const BASELINE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../docs/conformance/phase0/baseline.json", import.meta.url)), "utf8"),
);

const clone = (value) => JSON.parse(JSON.stringify(value));

test("the provenance list is exactly the commit sha", () => {
  // Adding an entry here must be a deliberate, reviewed act. Anything else in
  // the artifact moving is a real signal.
  assert.deepEqual([...PROVENANCE_POINTERS], ["versions.serverSha"]);
  assert.ok(Object.isFrozen(PROVENANCE_POINTERS));
});

test("a different commit sha alone does not turn the gate red", () => {
  const observed = clone(BASELINE);
  observed.versions.serverSha = "0".repeat(40);
  const { equal, provenance } = compareIgnoringProvenance(observed, BASELINE);
  assert.equal(equal, true);
  // …and the difference is reported rather than swallowed.
  assert.equal(provenance[0].observed, "0".repeat(40));
  assert.equal(provenance[0].committed, BASELINE.versions.serverSha);
});

test("every non-provenance field still turns the gate red", () => {
  // One case per class of regression the gate exists to catch.
  const mutations = {
    "a scenario relabelled": (artifact) => {
      artifact.conformance.matrix[0].status = "PASS";
    },
    "a counted result changed": (artifact) => {
      artifact.conformance.counts.PASS += 1;
    },
    "the tool inventory changed": (artifact) => {
      artifact.target.inventoryCounts.tools += 1;
    },
    "the resource inventory changed": (artifact) => {
      artifact.target.inventoryCounts.resources += 1;
    },
    "the SDK moved under us": (artifact) => {
      artifact.versions.sdkVersion = "9.9.9";
    },
    "the protocol version moved": (artifact) => {
      artifact.versions.protocolVersion = "1999-01-01";
    },
    "the pinned harness changed": (artifact) => {
      artifact.versions.conformanceVersion = "0.0.1";
    },
    "a harness tarball hash changed": (artifact) => {
      artifact.harnessIntegrity.conformance = "sha512-tampered";
    },
    "the server package version changed": (artifact) => {
      artifact.versions.serverPackageVersion = "0.0.0";
    },
    "the advertised capabilities changed": (artifact) => {
      delete artifact.target.advertisedCapabilities.prompts;
    },
  };

  for (const [label, mutate] of Object.entries(mutations)) {
    const observed = clone(BASELINE);
    mutate(observed);
    const { equal } = compareIgnoringProvenance(observed, BASELINE);
    assert.equal(equal, false, `masking hid a real drift: ${label}`);
  }
});

test("masking does not invent structure the artifact lacks", () => {
  // A baseline that lost `versions` entirely must not compare equal to one that
  // still has it — the mask has to be a no-op on an absent pointer, not a write.
  const stripped = clone(BASELINE);
  delete stripped.versions;
  assert.equal(compareIgnoringProvenance(stripped, BASELINE).equal, false);
  assert.equal(readPointer(stripped, "versions.serverSha"), undefined);
  assert.ok(!("versions" in maskProvenance(stripped)));
});

test("the mask leaves the rest of the artifact untouched", () => {
  const masked = maskProvenance(BASELINE);
  const expected = clone(BASELINE);
  expected.versions.serverSha = "<provenance>";
  assert.deepEqual(masked, expected);
});

test("the committed sha is still a real commit sha", () => {
  // The shape rule stays enforced: masking the comparison must not let a
  // garbage or placeholder value sit in the committed artifact.
  assert.match(BASELINE.versions.serverSha, /^[0-9a-f]{40}$/);
});
