#!/usr/bin/env node
// Refuse a tagged deploy that would ship POSTERN_TEST_PBKDF2_ITERATIONS (#909).
//
// That variable lowers PBKDF2 iterations. It is a test-only override. A real
// deploy must not carry it as a wrangler var or as a Worker secret (secrets
// persist across deploys even when the config does not mention them).
//
// WHAT IT GATES:
//   1. the rendered wrangler config about to be deployed (`vars` key present)
//   2. the live Worker secret list (name present)
//
// DESIGN RULES (same as forwarding-preflight.mjs):
//
// * A READ IT COULD NOT PERFORM IS NEVER A PASS, except a genuine HTTP 404
//   (the Worker does not exist yet, so there are no secrets). A 403/500 or
//   unparseable body refuses: an absent check reads exactly like a passed one.
//
// * IT NEVER PRINTS THE VALUE. The message names the variable. The suite
//   plants a distinctive value and asserts it does not appear.
//
// USAGE
//   node test-only-var-preflight.mjs <deploy-config.json(c)> <secrets.json> <http-status>
//
// Exit 0 = safe to deploy. Exit 1 = refuse. Exit 2 = usage.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripJsonc, configVars } from "./forwarding-preflight.mjs";
import { TEST_PBKDF2_ITERATIONS_VAR, testOnlyVarPresent, testOnlyVarRefusal } from "../../deploy/lib/test-only-var.mjs";

function secretNamesFromBody(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.result)) return body.result;
  return null;
}

function main(argv) {
  const [configPath, secretsPath, statusRaw] = argv;
  if (!configPath || !secretsPath || !statusRaw) {
    console.error("usage: test-only-var-preflight.mjs <deploy-config.json(c)> <secrets.json> <http-status>");
    return 2;
  }
  const status = Number(statusRaw);

  let config;
  try {
    config = JSON.parse(stripJsonc(readFileSync(configPath, "utf8")));
  } catch (e) {
    console.error(`::error title=Test-only var preflight::Deploy config ${configPath} did not parse (${e.message}). REFUSING to deploy.`);
    return 1;
  }
  const incoming = configVars(config);
  if (incoming === null) {
    console.error("::error title=Test-only var preflight::The deploy config has a `vars` key that is not an object. REFUSING to deploy.");
    return 1;
  }

  let secretNames = [];
  if (status === 404) {
    console.log("::notice title=Test-only var preflight::The Worker does not exist on the account yet (HTTP 404), so there is no secret list. Checking the config vars only.");
  } else if (!Number.isFinite(status) || status !== 200) {
    console.error(`::error title=Test-only var preflight::Could not read the Worker secret list (HTTP ${statusRaw}). REFUSING to deploy: a preflight that cannot read live secrets must not pass. Fix the credential or the script name and re-run.`);
    return 1;
  } else {
    let body;
    try {
      body = JSON.parse(readFileSync(secretsPath, "utf8"));
    } catch (e) {
      console.error(`::error title=Test-only var preflight::Worker secret list response is not JSON (${e.message}). REFUSING to deploy blind.`);
      return 1;
    }
    if (body && body.success === false) {
      console.error("::error title=Test-only var preflight::Cloudflare reported success:false for the secret list. REFUSING to deploy blind.");
      return 1;
    }
    const names = secretNamesFromBody(body);
    if (names === null) {
      console.error("::error title=Test-only var preflight::Secret list carried no result array, so whether the test-only override is a secret is unknown. REFUSING to deploy blind rather than assuming it is absent.");
      return 1;
    }
    secretNames = names;
  }

  const { inVars, inSecrets } = testOnlyVarPresent(incoming, secretNames);
  console.log(`  ${TEST_PBKDF2_ITERATIONS_VAR}: vars=${inVars ? "PRESENT" : "ABSENT"} secrets=${inSecrets ? "PRESENT" : "ABSENT"}`);

  const msg = testOnlyVarRefusal(incoming, secretNames);
  if (msg) {
    console.error(`::error title=Test-only var preflight::${msg}`);
    console.error("REFUSING the deploy. A lower PBKDF2 count weakens every stored password. Remove the variable from the operator config (POSTERN_INBOUND_WRANGLER) and from the Worker secrets, then re-run.");
    return 1;
  }

  console.log("Test-only var preflight OK: " + TEST_PBKDF2_ITERATIONS_VAR + " is not in the config vars or the Worker secret list.");
  return 0;
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === here) {
  process.exit(main(process.argv.slice(2)));
}
