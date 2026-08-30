#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const OFFICIAL_SCHEMA_SHA256 =
  "aa7d1bd554e6c615d411c03e5b73bb464816be603461eb5813bb589645550304";
const schemaPath = fileURLToPath(
  new URL("../marketplace/openai/chatgpt-app-submission.v1.schema.json", import.meta.url),
);
const submissionPath = fileURLToPath(
  new URL("../marketplace/openai/chatgpt-app-submission.json", import.meta.url),
);

const [schemaText, submissionText] = await Promise.all([
  readFile(schemaPath, "utf8"),
  readFile(submissionPath, "utf8"),
]);
const hash = createHash("sha256").update(schemaText).digest("hex");
if (hash !== OFFICIAL_SCHEMA_SHA256) {
  throw new Error(
    `Pinned OpenAI submission schema hash drifted: ${hash}; expected ${OFFICIAL_SCHEMA_SHA256}`,
  );
}

const schema = JSON.parse(schemaText);
const submission = JSON.parse(submissionText);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);
if (!validate(submission)) {
  throw new Error(
    `OpenAI submission JSON violates the pinned official schema:\n${JSON.stringify(validate.errors, null, 2)}`,
  );
}

console.log(
  `OpenAI submission validates against pinned official schema ${OFFICIAL_SCHEMA_SHA256}`,
);
