/**
 * Checks the setup script's dry-run paths: local checkout, no install, no
 * deploy, no network, and the deploy flags that do not require an account.
 */

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_ENV = {
  ...process.env,
  UPLOAD_SECRET: "",
  RETRIEVE_SECRET: "",
  CLOUDFLARE_API_TOKEN: "",
  CLOUDFLARE_ACCOUNT_ID: "",
  FHS_SECRET_FILE: path.join(os.tmpdir(), `fhs-setup-test-${process.pid}`),
};

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, ["scripts/setup.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
    env: { ...BASE_ENV, ...extraEnv },
  });
}

function assertOk(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

const base = run(["--dry-run", "--repo", "."]);
assertOk(base, "setup --dry-run");
assert.match(base.stdout, /Dry run: nothing was installed or deployed/i);
assert.match(base.stdout, /package\.json, wrangler\.jsonc, src\/index\.js/);
assert.match(base.stdout, /npm install/);
assert.match(base.stdout, /wrangler deploy/);
assert.match(base.stdout, /verify upload, retrieve, and 410/);
assert.match(base.stdout, /subdomain/);

const open = run(["--dry-run", "--repo", ".", "--no-upload-secret"]);
assertOk(open, "setup --no-upload-secret");
assert.match(open.stdout, /leave uploads open/i);
assert.doesNotMatch(open.stdout, /set UPLOAD_SECRET from/);

const config = run([
  "--dry-run",
  "--repo",
  ".",
  "--config",
  "deploy/pdf-only.jsonc",
]);
assertOk(config, "setup --config");
assert.match(config.stdout, /Files:.*deploy\/pdf-only\.jsonc/);
assert.match(config.stdout, /wrangler deploy --config deploy\/pdf-only\.jsonc/);

const subdomain = run([
  "--dry-run",
  "--repo",
  ".",
  "--subdomain",
  "fhs-test",
]);
assertOk(subdomain, "setup --subdomain");
assert.match(subdomain.stdout, /create or check workers\.dev subdomain: fhs-test/);

const badSubdomain = run([
  "--dry-run",
  "--repo",
  ".",
  "--subdomain",
  "Bad_Name",
]);
assert.notEqual(badSubdomain.status, 0, "invalid subdomain should fail");
assert.match(badSubdomain.stderr, /letters, digits, or hyphens/);

const missingConfig = run([
  "--dry-run",
  "--repo",
  ".",
  "--config",
  "deploy/not-there.jsonc",
]);
assert.notEqual(missingConfig.status, 0, "missing config should fail");
assert.match(missingConfig.stderr, /Config file not found/);

const conflict = run(["--dry-run", "--repo", ".", "--no-upload-secret"], {
  UPLOAD_SECRET: "do-not-use",
});
assert.notEqual(conflict.status, 0, "--no-upload-secret should reject an env secret");
assert.match(conflict.stderr, /conflicts with UPLOAD_SECRET/);

console.log("setup script dry runs: ok (7 checks, no install, no deploy)");
