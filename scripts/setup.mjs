#!/usr/bin/env node

/**
 * Deploy File Handoff Service (FHS) to your own Cloudflare account from any
 * repository, without copying this code or any secret into that repository.
 *
 * From another project:
 *   curl -fsSL https://raw.githubusercontent.com/Spuds0588/File-Handoff-Service-FHS-/main/scripts/setup.mjs -o /tmp/fhs-setup.mjs
 *   node /tmp/fhs-setup.mjs --dry-run
 *   node /tmp/fhs-setup.mjs
 *
 * What it does:
 *   1. Checks out this repository into a temporary directory (or uses --repo .).
 *   2. Installs dependencies.
 *   3. Deploys the Worker with wrangler.
 *   4. Sets UPLOAD_SECRET as a Worker secret: from the environment, or reused
 *      from ~/.fhs/upload-secret, or generated there with mode 600.
 *   5. Verifies upload -> retrieve -> 410 against the live URL.
 *   6. Deletes the temporary checkout.
 *
 * Nothing is written into the current repository, and secret values are never
 * printed. Requires Node 20.3+, git, and an authenticated wrangler.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_REPO = "https://github.com/Spuds0588/File-Handoff-Service-FHS-.git";
const DEFAULT_REF = "main";
const DEFAULT_SECRET_FILE = path.join(os.homedir(), ".fhs", "upload-secret");
const SECRET_NAME = "UPLOAD_SECRET";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const options = {
  repo: DEFAULT_REPO,
  ref: DEFAULT_REF,
  dryRun: false,
  keep: false,
  help: false,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--keep") options.keep = true;
  else if (arg === "--help" || arg === "-h") options.help = true;
  else if (arg === "--repo") {
    options.repo = argv[++i];
    if (!options.repo) fail("--repo needs a value.");
  } else if (arg === "--ref") {
    options.ref = argv[++i];
    if (!options.ref) fail("--ref needs a value.");
  } else {
    fail(`Unknown option: ${arg}. Use --help.`);
  }
}

let tempDir = null;
let keep = options.keep;

function cleanup() {
  if (!tempDir || keep) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function fail(message, code = 1) {
  console.error(`\nFHS setup: ${message}\n`);
  process.exit(code);
}

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 600000, ...extra });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") fail(`${command} timed out.`);
    fail(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
  return result;
}

function capture(command, args, extra = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 600000, ...extra });
}

function printUsage() {
  console.log(`FHS setup — deploy the relay without adding anything to this repo.

Usage: node setup.mjs [options]

Options:
  --dry-run          Check the source and print the plan. Installs and deploys nothing.
  --repo <url|path>  Repository to deploy from, or a local checkout (default: ${DEFAULT_REPO}).
  --ref <ref>        Branch or tag to deploy (default: ${DEFAULT_REF}).
  --keep             Keep the temporary checkout for inspection.
  --help             Show this message.

Environment:
  ${SECRET_NAME}            Upload bearer token. When unset, the script reuses or
                            generates ${DEFAULT_SECRET_FILE} (mode 600).
  FHS_SECRET_FILE           Override the generated secret path.
  CLOUDFLARE_API_TOKEN      Optional. Otherwise run \`npx wrangler login\` first.
`);
}

if (options.help) {
  printUsage();
  process.exit(0);
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 3)) {
  fail(`Node 20.3 or newer is required (found ${process.version}).`);
}

const secretFile = process.env.FHS_SECRET_FILE || DEFAULT_SECRET_FILE;
const envSecret = (process.env[SECRET_NAME] || "").trim();

/* ------------------------------------------------------------------ */
/* 1. Source checkout                                                  */
/* ------------------------------------------------------------------ */

const isRemote = /^(https?:\/\/|git@)/.test(options.repo);
let workDir;

if (isRemote) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fhs-setup-"));
  workDir = path.join(tempDir, "fhs");
  console.log(`Checking out ${options.repo} (${options.ref})...`);
  run("git", ["clone", "--depth", "1", "--branch", options.ref, options.repo, workDir], {
    timeout: 180000,
  });
} else {
  workDir = path.resolve(options.repo);
  console.log(`Using checkout at ${workDir}`);
}

for (const file of ["package.json", "wrangler.jsonc", "src/index.js"]) {
  if (!fs.existsSync(path.join(workDir, file))) {
    fail(`${workDir} is not an FHS checkout: ${file} is missing.`);
  }
}

/* ------------------------------------------------------------------ */
/* 2. Dry run                                                          */
/* ------------------------------------------------------------------ */

if (options.dryRun) {
  console.log(`\nSource: ${workDir}`);
  console.log("Files:  package.json, wrangler.jsonc, src/index.js");
  console.log("\nDry run: nothing was installed or deployed.\n");
  console.log("Plan:");
  console.log("  1. npm install");
  console.log("  2. npx wrangler whoami");
  console.log("  3. npx wrangler deploy");
  if (envSecret) {
    console.log(`  4. set ${SECRET_NAME} from the environment (value not printed)`);
  } else if (fs.existsSync(secretFile)) {
    console.log(`  4. reuse ${SECRET_NAME} from ${secretFile} (value not printed)`);
  } else {
    console.log(`  4. generate ${SECRET_NAME} at ${secretFile} (mode 600)`);
  }
  console.log("  5. verify upload, retrieve, and 410 against the live URL");
  console.log("  6. remove the temporary checkout");
  console.log("\nRe-run without --dry-run to deploy.");
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 3. Install, authenticate, deploy                                    */
/* ------------------------------------------------------------------ */

if (!fs.existsSync(path.join(workDir, "node_modules", "wrangler"))) {
  console.log("\nInstalling dependencies...");
  run(NPM, ["install", "--no-fund", "--no-audit"], { cwd: workDir, timeout: 600000 });
} else {
  console.log("\nDependencies already installed.");
}

console.log("\nChecking Cloudflare authentication...");
const whoami = capture(NPX, ["wrangler", "whoami"], { cwd: workDir, timeout: 120000 });
if (whoami.error || whoami.status !== 0) {
  if (whoami.stdout) process.stdout.write(whoami.stdout);
  if (whoami.stderr) process.stderr.write(whoami.stderr);
  fail(
    "Wrangler is not authenticated. Run `npx wrangler login` first, or set CLOUDFLARE_API_TOKEN in your environment (never in the repo).",
    2,
  );
}

console.log("Deploying the Worker...");
const deploy = capture(NPX, ["wrangler", "deploy"], { cwd: workDir, timeout: 600000 });
if (deploy.error) fail(`wrangler deploy could not run: ${deploy.error.message}`);
if (deploy.stdout) process.stdout.write(deploy.stdout);
if (deploy.stderr) process.stderr.write(deploy.stderr);
if (deploy.status !== 0) fail("wrangler deploy failed. See the output above.", 1);

const output = `${deploy.stdout || ""}\n${deploy.stderr || ""}`;
const urls = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi) || [];
const baseUrl = urls.length ? urls[urls.length - 1].replace(/\/+$/, "") : null;
if (baseUrl) {
  console.log(`\nWorker: ${baseUrl}`);
} else {
  console.warn(
    "\nCould not read the workers.dev URL from the deploy output. Find it in the Cloudflare dashboard.",
  );
}

/* ------------------------------------------------------------------ */
/* 4. Upload secret                                                    */
/* ------------------------------------------------------------------ */

let secret = envSecret;
let secretSource;

if (secret) {
  secretSource = `read from ${SECRET_NAME} (value not printed)`;
} else if (fs.existsSync(secretFile)) {
  secret = fs.readFileSync(secretFile, "utf8").trim();
  if (!secret) fail(`Secret file ${secretFile} is empty. Delete it or set ${SECRET_NAME}.`);
  secretSource = `reused ${secretFile} (value not printed)`;
} else {
  secret = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(secretFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  secretSource = `generated ${secretFile} (mode 600, value not printed)`;
}

console.log(`\nSetting ${SECRET_NAME} as a Worker secret...`);
const put = capture(NPX, ["wrangler", "secret", "put", SECRET_NAME], {
  cwd: workDir,
  input: `${secret}\n`,
  timeout: 120000,
});
if (put.error || put.status !== 0) {
  if (put.stdout) process.stdout.write(put.stdout);
  if (put.stderr) process.stderr.write(put.stderr);
  fail(
    `The Worker is deployed but ${SECRET_NAME} was not set, so uploads may be open. Set it now: npx wrangler secret put ${SECRET_NAME}`,
    1,
  );
}
console.log(`  ${secretSource}`);

/* ------------------------------------------------------------------ */
/* 5. Live verification                                                */
/* ------------------------------------------------------------------ */

async function verify(base, uploadSecret) {
  const headers = { Authorization: `Bearer ${uploadSecret}` };

  let descriptor = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) {
        descriptor = await response.json();
        break;
      }
    } catch {
      /* not resolvable yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!descriptor) throw new Error("the descriptor never returned 200");
  if (descriptor.retention !== "zero-disk") throw new Error("unexpected descriptor payload");

  const payload = `fhs-setup-${Date.now()}`;
  let upload = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    upload = await fetch(`${base}/upload`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: payload,
    });
    if (upload.status !== 401) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!upload || upload.status !== 201) {
    throw new Error(`upload returned ${upload ? upload.status : "no response"}`);
  }

  const info = await upload.json();
  const first = await fetch(info.handoffUrl);
  const received = await first.text();
  if (first.status !== 200 || received !== payload) {
    throw new Error("retrieved bytes did not match what was uploaded");
  }

  const second = await fetch(info.handoffUrl);
  if (second.status !== 410) throw new Error(`second retrieve returned ${second.status}`);

  return info.totalBytes;
}

if (baseUrl) {
  console.log("\nVerifying the live deployment...");
  try {
    const bytes = await verify(baseUrl, secret);
    console.log(`  ok: upload, retrieve, and 410 (${bytes} bytes)`);
  } catch (error) {
    fail(`The Worker deployed, but verification failed: ${error.message}`, 1);
  }
}

/* ------------------------------------------------------------------ */
/* 6. Summary                                                          */
/* ------------------------------------------------------------------ */

console.log("\nDone.");
if (baseUrl) console.log(`  Worker: ${baseUrl}`);
console.log(`  Upload secret: ${secretSource}`);
if (!envSecret) {
  console.log(`  Use it:   curl -sS -H "Authorization: Bearer $(cat ${secretFile})" ${baseUrl || "<worker-url>"}/`);
  console.log("  Keep it outside version control. Delete the file after moving it to a password manager.");
}
console.log("  Limits:   edit TTL_SECONDS, MAX_PAYLOAD_BYTES, CHUNK_SIZE_BYTES in wrangler.jsonc.");
if (tempDir && keep) console.log(`\nKept checkout: ${workDir}`);
