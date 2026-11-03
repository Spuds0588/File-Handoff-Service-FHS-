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
 *   3. Optionally creates a workers.dev subdomain with --subdomain (needs
 *      CLOUDFLARE_API_TOKEN), or explains Cloudflare error 10063.
 *   4. Deploys the Worker with wrangler, optionally with --config.
 *   5. Sets UPLOAD_SECRET as a Worker secret (unless --no-upload-secret): from
 *      the environment, or reused from ~/.fhs/upload-secret, or generated there
 *      with mode 600.
 *   6. Reads GET / and verifies upload -> retrieve -> 410 against the live URL,
 *      using the deployment's actual MIME filter.
 *   7. Deletes the temporary checkout.
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
  config: null,
  subdomain: null,
  noUploadSecret: false,
  dryRun: false,
  keep: false,
  help: false,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--keep") options.keep = true;
  else if (arg === "--no-upload-secret") options.noUploadSecret = true;
  else if (arg === "--help" || arg === "-h") options.help = true;
  else if (arg === "--config") {
    options.config = argv[++i];
    if (!options.config) fail("--config needs a value.");
  } else if (arg === "--subdomain") {
    options.subdomain = (argv[++i] || "").toLowerCase();
    if (!options.subdomain) fail("--subdomain needs a value.");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(options.subdomain)) {
      fail("--subdomain must be 1-63 letters, digits, or hyphens, and cannot start or end with a hyphen.");
    }
  } else if (arg === "--repo") {
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
  --dry-run              Check the source and print the plan. Installs and deploys nothing.
  --repo <url|path>      Repository to deploy from, or a local checkout (default: ${DEFAULT_REPO}).
  --ref <ref>            Branch or tag to deploy (default: ${DEFAULT_REF}).
  --config <file>        Wrangler config inside the checkout (default: wrangler.jsonc).
  --no-upload-secret     Do not set UPLOAD_SECRET. Uploads are open on a fresh Worker;
                         an existing secret is not deleted.
  --subdomain <name>     Create or check a workers.dev subdomain. Needs
                         CLOUDFLARE_API_TOKEN; otherwise use the dashboard once.
  --keep                 Keep the temporary checkout for inspection.
  --help                 Show this message.

Environment:
  ${SECRET_NAME}            Upload bearer token. When unset, the script reuses or
                            generates ${DEFAULT_SECRET_FILE} (mode 600).
  RETRIEVE_SECRET          Optional. Used only to verify a retrieve side that is
                            already gated; the script does not set it.
  FHS_SECRET_FILE           Override the generated secret path.
  CLOUDFLARE_API_TOKEN      Optional. Otherwise run \`npx wrangler login\` first.
  CLOUDFLARE_ACCOUNT_ID     Optional when the account has more than one membership.
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
const retrieveSecret = (process.env.RETRIEVE_SECRET || "").trim();

if (options.noUploadSecret && envSecret) {
  fail(`--no-upload-secret conflicts with ${SECRET_NAME} in the environment. Unset it or omit the flag.`);
}

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

let configFile = "wrangler.jsonc";
if (options.config) {
  const resolved = path.resolve(workDir, options.config);
  const relative = path.relative(workDir, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("--config must point to a file inside the FHS checkout.");
  }
  if (!fs.existsSync(resolved)) {
    fail(`Config file not found: ${resolved}`);
  }
  configFile = relative.split(path.sep).join("/");
}
const configArgs = options.config ? ["--config", configFile] : [];

/* ------------------------------------------------------------------ */
/* 2. Dry run                                                          */
/* ------------------------------------------------------------------ */

if (options.dryRun) {
  console.log(`\nSource: ${workDir}`);
  console.log(`Files:  package.json, ${configFile}, src/index.js`);
  console.log("\nDry run: nothing was installed or deployed.\n");
  console.log("Plan:");
  console.log("  1. npm install");
  console.log("  2. npx wrangler whoami");
  if (options.subdomain) {
    console.log(`  3. create or check workers.dev subdomain: ${options.subdomain}`);
  } else {
    console.log("  3. skip subdomain setup (a new account must create one in Workers & Pages)");
  }
  console.log(`  4. npx wrangler deploy${options.config ? ` --config ${configFile}` : ""}`);
  if (options.noUploadSecret) {
    console.log(`  5. leave uploads open (${SECRET_NAME} is not set; an existing secret is not deleted)`);
  } else if (envSecret) {
    console.log(`  5. set ${SECRET_NAME} from the environment (value not printed)`);
  } else if (fs.existsSync(secretFile)) {
    console.log(`  5. reuse ${SECRET_NAME} from ${secretFile} (value not printed)`);
  } else {
    console.log(`  5. generate ${SECRET_NAME} at ${secretFile} (mode 600)`);
  }
  console.log("  6. read GET / and verify upload, retrieve, and 410 against the live URL");
  if (retrieveSecret) console.log("     (RETRIEVE_SECRET from the environment will be used for the retrieve check)");
  console.log("  7. remove the temporary checkout");
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
const whoami = capture(NPX, ["wrangler", "whoami", "--json"], {
  cwd: workDir,
  timeout: 120000,
  env: { ...process.env, NO_COLOR: "1" },
});
if (whoami.error || whoami.status !== 0) {
  if (whoami.stdout) process.stdout.write(whoami.stdout);
  if (whoami.stderr) process.stderr.write(whoami.stderr);
  fail(
    "Wrangler is not authenticated. Run `npx wrangler login` first, or set CLOUDFLARE_API_TOKEN in your environment (never in the repo).",
    2,
  );
}

let identity;
try {
  identity = JSON.parse(whoami.stdout || "{}");
} catch {
  fail("Wrangler returned unreadable account information. Run `npx wrangler whoami` to inspect it.", 2);
}
if (!identity.loggedIn) {
  fail(
    "Wrangler is not authenticated. Run `npx wrangler login` first, or set CLOUDFLARE_API_TOKEN in your environment (never in the repo).",
    2,
  );
}
const accounts = Array.isArray(identity.accounts) ? identity.accounts : [];

function selectedAccountId() {
  const configured = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  if (configured) return configured;
  if (accounts.length === 1) return accounts[0].id;
  fail(
    "Could not choose a Cloudflare account. Set CLOUDFLARE_ACCOUNT_ID to the account you want to deploy to.",
  );
}

async function ensureSubdomain(accountId, subdomain, token) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const readBody = async (response) => {
    try {
      return await response.json();
    } catch {
      return null;
    }
  };
  const apiError = (response, body) => {
    const detail = body?.errors?.[0]?.message || "no error detail";
    fail(`Cloudflare API returned HTTP ${response.status}: ${detail}`);
  };

  let response;
  try {
    response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    fail(`Could not reach the Cloudflare API: ${error.message}`);
  }
  const current = await readBody(response);
  if (!response.ok || current?.success === false) apiError(response, current);

  const existing = current?.result?.subdomain;
  if (existing) {
    if (existing.toLowerCase() !== subdomain.toLowerCase()) {
      fail(
        `The account already has the workers.dev subdomain "${existing}". Omit --subdomain to use it, or choose that name.`,
      );
    }
    console.log(`  workers.dev subdomain already exists: ${subdomain}`);
    return;
  }

  try {
    response = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({ subdomain }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    fail(`Could not create the workers.dev subdomain: ${error.message}`);
  }
  const created = await readBody(response);
  if (!response.ok || created?.success === false) apiError(response, created);
  console.log(`  workers.dev subdomain ready: ${subdomain}`);
}

if (options.subdomain) {
  const token = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  if (!token) {
    fail(
      "--subdomain needs CLOUDFLARE_API_TOKEN so the script can call the Cloudflare API. With OAuth login, open Workers & Pages in the dashboard once instead, then rerun without --subdomain.",
    );
  }
  console.log("\nChecking the workers.dev subdomain...");
  await ensureSubdomain(selectedAccountId(), options.subdomain, token);
}

console.log("Deploying the Worker...");
const deploy = capture(NPX, ["wrangler", "deploy", ...configArgs], {
  cwd: workDir,
  timeout: 600000,
});
if (deploy.error) fail(`wrangler deploy could not run: ${deploy.error.message}`);
if (deploy.stdout) process.stdout.write(deploy.stdout);
if (deploy.stderr) process.stderr.write(deploy.stderr);
const deployOutput = `${deploy.stdout || ""}\n${deploy.stderr || ""}`;
if (deploy.status !== 0) {
  if (/10063|workers\.dev subdomain/i.test(deployOutput)) {
    const accountId = accounts.length === 1 ? accounts[0].id : null;
    const dashboard = accountId
      ? `https://dash.cloudflare.com/${accountId}/workers-and-pages`
      : "https://dash.cloudflare.com/";
    fail(
      `Cloudflare rejected the deploy because this account has no workers.dev subdomain. Open ${dashboard} once to create it, or set CLOUDFLARE_API_TOKEN and rerun with --subdomain <name>.`,
      1,
    );
  }
  fail("wrangler deploy failed. See the output above.", 1);
}

const output = deployOutput;
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

let secret = null;
let secretSource;

if (options.noUploadSecret) {
  secretSource = "skipped (--no-upload-secret; an existing secret is not deleted)";
  console.log(`\nSkipping ${SECRET_NAME}; uploads will be open on a fresh Worker.`);
} else {
  secret = envSecret;
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
  const put = capture(NPX, ["wrangler", "secret", "put", SECRET_NAME, ...configArgs], {
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
}

/* ------------------------------------------------------------------ */
/* 5. Live verification                                                */
/* ------------------------------------------------------------------ */

function chooseProbeType(descriptor) {
  const allowed = descriptor?.filters?.allowedContentTypes;
  if (!Array.isArray(allowed) || allowed.length === 0) return "text/plain";
  for (const rule of allowed) {
    if (!rule || rule === "*" || rule === "*/*") return "text/plain";
    if (rule === "text/*") return "text/plain";
    if (rule === "image/*") return "image/png";
    if (rule.endsWith("/*")) return `${rule.slice(0, -1)}octet-stream`;
    if (rule.includes("/")) return rule;
  }
  return "text/plain";
}

async function verify(base, uploadSecret, retrieveSecret) {
  const uploadAuth = uploadSecret ? { Authorization: `Bearer ${uploadSecret}` } : {};
  const retrieveAuth = retrieveSecret ? { Authorization: `Bearer ${retrieveSecret}` } : {};

  let descriptor = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        descriptor = await response.json();
        break;
      }
    } catch {
      /* not resolvable yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!descriptor) {
    throw new Error(
      "the descriptor never returned 200 after 60 seconds; a new workers.dev subdomain can reject TLS for up to a minute",
    );
  }
  if (descriptor.retention !== "zero-disk") throw new Error("unexpected descriptor payload");

  const probeType = chooseProbeType(descriptor);
  const payload =
    probeType === "application/pdf"
      ? `%PDF-1.4\n% FHS setup probe ${Date.now()}\n`
      : `fhs-setup-${Date.now()}`;
  let upload = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      upload = await fetch(`${base}/upload`, {
        method: "POST",
        headers: { ...uploadAuth, "Content-Type": probeType },
        body: payload,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      upload = null;
    }
    if (upload?.status !== 401 || !uploadSecret) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!upload) throw new Error("upload returned no response");
  if (upload.status === 401 && !uploadSecret) {
    return {
      skipped:
        "the deployment still requires UPLOAD_SECRET; --no-upload-secret does not delete an existing secret",
    };
  }
  if (upload.status === 415) {
    return {
      skipped: `the deployment's ALLOWED_CONTENT_TYPES rejected the ${probeType} probe`,
    };
  }
  if (upload.status !== 201) {
    throw new Error(`upload returned ${upload ? upload.status : "no response"}`);
  }

  const info = await upload.json();
  if (info.contentType !== probeType) {
    throw new Error(`upload echoed ${info.contentType}, expected ${probeType}`);
  }
  const first = await fetch(info.handoffUrl, {
    headers: retrieveAuth,
    signal: AbortSignal.timeout(20000),
  });
  if (first.status === 401 && !retrieveSecret) {
    return {
      skipped:
        "retrieval requires RETRIEVE_SECRET; set it in the environment to complete the retrieve check",
    };
  }
  const received = await first.text();
  if (first.status !== 200 || received !== payload) {
    throw new Error(
      first.status === 401
        ? "retrieve returned 401; RETRIEVE_SECRET did not match"
        : "retrieved bytes did not match what was uploaded",
    );
  }

  const second = await fetch(info.handoffUrl, {
    headers: retrieveAuth,
    signal: AbortSignal.timeout(20000),
  });
  if (second.status !== 410) throw new Error(`second retrieve returned ${second.status}`);

  return info.totalBytes;
}

if (baseUrl) {
  console.log("\nVerifying the live deployment...");
  try {
    const result = await verify(baseUrl, secret, retrieveSecret);
    if (result && typeof result === "object" && result.skipped) {
      console.warn(`  deployed; verification skipped: ${result.skipped}`);
    } else {
      console.log(`  ok: upload, retrieve, and 410 (${result} bytes)`);
    }
  } catch (error) {
    fail(`The Worker deployed, but verification failed: ${error.message}`, 1);
  }
}

/* ------------------------------------------------------------------ */
/* 6. Summary                                                          */
/* ------------------------------------------------------------------ */

console.log("\nDone.");
if (baseUrl) console.log(`  Worker: ${baseUrl}`);
if (secret) {
  console.log(`  Upload secret: ${secretSource}`);
} else if (options.noUploadSecret) {
  console.log(`  Upload secret: ${secretSource}`);
}
if (secret && !envSecret) {
  console.log(`  Use it:   curl -sS -H "Authorization: Bearer $(cat ${secretFile})" ${baseUrl || "<worker-url>"}/`);
  console.log("  Keep it outside version control. Delete the file after moving it to a password manager.");
}
console.log(`  Config:   ${configFile}`);
console.log("  Limits:   edit TTL_SECONDS, MAX_PAYLOAD_BYTES, CHUNK_SIZE_BYTES in that config.");
if (tempDir && keep) console.log(`\nKept checkout: ${workDir}`);
