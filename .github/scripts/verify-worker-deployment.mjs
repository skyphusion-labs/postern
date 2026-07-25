#!/usr/bin/env node
// Post-deploy ARTIFACT verification (#418 item 5).
//
// WHY: deploy.yml used to end at `npx wrangler deploy`, so the only evidence a
// release produced was a green pipeline. This repo doctrine is the opposite --
// "verify the ARTIFACT, not the pipeline" -- and a green deploy job is not
// evidence the live Worker changed. This reads the deployment back out of the
// Cloudflare API (`wrangler deployments status --json`) and asserts the version
// that was just uploaded is the one now serving production.
//
// Usage: node verify-worker-deployment.mjs <deployment-json> <expected-version-id>
//
// <deployment-json> is the raw output of:
//   npx wrangler deployments status --json -c <config>
// which (wrangler 4.x) is the latest deployment object:
//   { "id": "...", "created_on": "...", "versions": [ { "version_id": "...",
//     "percentage": 100 } ], ... }
//
// Refuses honestly: an unparseable body, a missing/empty versions array, or a
// deployment whose versions do not include the uploaded one all exit 1. It
// never passes on an unrecognized shape, because "could not tell" and "verified"
// are different answers and only one of them may be green.
import { readFileSync } from "node:fs";

const die = (msg) => {
  console.error(`::error::artifact verification failed: ${msg}`);
  process.exit(1);
};

const [jsonPath, expected] = process.argv.slice(2);
if (!jsonPath || !expected) {
  die("usage: verify-worker-deployment.mjs <deployment-json> <expected-version-id>");
}

let raw;
try {
  raw = readFileSync(jsonPath, "utf8");
} catch (e) {
  die(`cannot read ${jsonPath}: ${e.message}`);
}

let deployment;
try {
  deployment = JSON.parse(raw);
} catch (e) {
  die(`deployment read-back is not JSON (${e.message}); wrangler output shape may have changed`);
}

if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
  die("deployment read-back is not a deployment object");
}

const versions = deployment.versions;
if (!Array.isArray(versions) || versions.length === 0) {
  die("deployment read-back carries no versions array; cannot confirm what is live");
}

const ids = versions
  .map((v) => (v && typeof v.version_id === "string" ? v.version_id : null))
  .filter((id) => id !== null);

if (ids.length === 0) {
  die("no version_id in the deployment read-back; wrangler output shape may have changed");
}

if (!ids.includes(expected)) {
  die(
    `the live deployment serves version(s) ${ids.join(", ")}, not the ${expected} ` +
      "just uploaded; production is NOT running this tag",
  );
}

const share = versions
  .filter((v) => v && v.version_id === expected)
  .map((v) => (typeof v.percentage === "number" ? `${v.percentage}%` : "unknown share"))
  .join(", ");

console.log(
  `Artifact verified: live deployment ${deployment.id ?? "(no id)"} ` +
    `serves version ${expected} (${share || "share unreported"}), ` +
    `created ${deployment.created_on ?? "(no timestamp)"}.`,
);
