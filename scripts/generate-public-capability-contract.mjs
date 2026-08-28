#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  assertPublicCapabilityContract,
  capturePublicCapabilityContract,
  serializePublicCapabilityContract,
} from "../dist/public-capability-contract.js";

const fixturePath = fileURLToPath(
  new URL("../src/__tests__/fixtures/public-capability-contract.json", import.meta.url),
);

const actual = await capturePublicCapabilityContract();
const serialized = serializePublicCapabilityContract(actual);

if (process.argv.includes("--check")) {
  const expected = JSON.parse(await readFile(fixturePath, "utf8"));
  assertPublicCapabilityContract(actual, expected);
  console.log(
    `Public capability contract matches: ${actual.catalogue.canonicalOperations} catalogue operations; ` +
      `${actual.surfaces.remoteGrouped.tools.length} grouped remote names; ` +
      `${actual.surfaces.remoteGrouped.resources.length} remote resources; ` +
      `${actual.surfaces.openaiFull.tools.length} OpenAI names`,
  );
} else {
  await writeFile(fixturePath, serialized);
  console.log(`Wrote ${fixturePath}`);
}
