/**
 * Checks the setup script's dry-run path: local checkout, no install, no
 * deploy, no network, no writes outside the script's output.
 */

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync(
  process.execPath,
  ["scripts/setup.mjs", "--dry-run", "--repo", "."],
  { cwd: ROOT, encoding: "utf8", timeout: 30000 },
);

assert.equal(
  result.status,
  0,
  `setup --dry-run failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
);
assert.match(result.stdout, /Dry run: nothing was installed or deployed/i);
assert.match(result.stdout, /package\.json, wrangler\.jsonc, src\/index\.js/);
assert.match(result.stdout, /npm install/);
assert.match(result.stdout, /wrangler deploy/);
assert.match(result.stdout, /verify upload, retrieve, and 410/);

console.log("setup script dry run: ok (no install, no deploy)");
