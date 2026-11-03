/**
 * Side-specific tests: upload and retrieve have independent domain filters and
 * optional secrets. The default-open e2e suite and the shared-fallback filter
 * suite cover the other configurations.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_PAYLOAD = 1024 * 1024;
const CHUNK = 256 * 1024;
const TTL = 30;
const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

assert.ok(
  fs.existsSync(WRANGLER),
  "wrangler is not installed. Run `npm install` first.",
);

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message || error}`);
  }
}

async function waitForServer(server, base, getLog) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`wrangler exited early with code ${server.exitCode}\n${getLog()}`);
    }
    try {
      const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`wrangler did not become ready within 120s\n${getLog()}`);
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    try {
      server.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const exited = await Promise.race([
    once(server, "exit").then(() => true),
    sleep(5000).then(() => false),
  ]);
  if (!exited) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function runCase(title, port, vars, checks) {
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  const args = [
    WRANGLER,
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    ...vars.flatMap((value) => ["--var", value]),
  ];
  const server = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });

  server.stdout.on("data", (data) => {
    log += data;
  });
  server.stderr.on("data", (data) => {
    log += data;
  });
  server.on("error", (error) => {
    log += `\nspawn error: ${error.message}`;
  });

  try {
    await waitForServer(server, base, () => log);
    console.log(`\n${title} (${base})\n`);
    for (const [name, fn] of checks) {
      await check(name, () => fn({ base, log: () => log }));
    }
  } finally {
    await stopServer(server);
  }
}

function upload(base, body, headers = {}) {
  return fetch(`${base}/upload`, { method: "POST", headers, body });
}

function retrieve(base, token, headers = {}) {
  return fetch(`${base}/retrieve/${token}`, { headers });
}

async function createHandoff(base, headers = {}) {
  const response = await upload(base, "payload", headers);
  assert.equal(response.status, 201);
  return response.json();
}

try {
  await runCase(
    "both sides filtered",
    8801,
    [
      "ALLOWED_UPLOAD_DOMAINS:upload.example.com",
      "ALLOWED_RETRIEVE_DOMAINS:retrieve.example.com",
      "RETRIEVE_SECRET:retrieve-secret",
      `MAX_PAYLOAD_BYTES:${MAX_PAYLOAD}`,
      `CHUNK_SIZE_BYTES:${CHUNK}`,
      `TTL_SECONDS:${TTL}`,
    ],
    [
      [
        "descriptor reports independent side filters",
        async ({ base }) => {
          const response = await fetch(`${base}/`);
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.deepEqual(body.filters.uploadDomains, ["upload.example.com"]);
          assert.deepEqual(body.filters.retrieveDomains, ["retrieve.example.com"]);
          assert.equal(body.auth.uploadSecretRequired, false);
          assert.equal(body.auth.retrieveSecretRequired, true);
        },
      ],
      [
        "upload uses only the upload domain list",
        async ({ base }) => {
          const allowed = await upload(base, "payload", {
            Origin: "https://upload.example.com",
          });
          assert.equal(allowed.status, 201);
          assert.equal(
            allowed.headers.get("access-control-allow-origin"),
            "https://upload.example.com",
          );

          const blocked = await upload(base, "payload", {
            Origin: "https://retrieve.example.com",
          });
          assert.equal(blocked.status, 403);

          const noOrigin = await upload(base, "payload");
          assert.equal(noOrigin.status, 201);
        },
      ],
      [
        "retrieve requires its own secret",
        async ({ base }) => {
          const { token } = await createHandoff(base);

          const missing = await retrieve(base, token, {
            Origin: "https://retrieve.example.com",
          });
          assert.equal(missing.status, 401);
          assert.equal(missing.headers.get("www-authenticate"), "Bearer");

          const wrong = await retrieve(base, token, {
            Origin: "https://retrieve.example.com",
            Authorization: "Bearer wrong",
          });
          assert.equal(wrong.status, 401);

          const ok = await retrieve(base, token, {
            Origin: "https://retrieve.example.com",
            Authorization: "Bearer retrieve-secret",
          });
          assert.equal(ok.status, 200);
          assert.equal(
            ok.headers.get("access-control-allow-origin"),
            "https://retrieve.example.com",
          );
          assert.equal(await ok.text(), "payload");
        },
      ],
      [
        "retrieve uses only the retrieve domain list",
        async ({ base }) => {
          const { token } = await createHandoff(base);

          const blocked = await retrieve(base, token, {
            Origin: "https://upload.example.com",
            Authorization: "Bearer retrieve-secret",
          });
          assert.equal(blocked.status, 403);

          const ok = await retrieve(base, token, {
            Origin: "https://retrieve.example.com",
            Authorization: "Bearer retrieve-secret",
          });
          assert.equal(ok.status, 200);
          await ok.text();
        },
      ],
      [
        "retrieve secret works for non-browser clients",
        async ({ base }) => {
          const { token } = await createHandoff(base);
          const response = await retrieve(base, token, {
            Authorization: "Bearer retrieve-secret",
          });
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("access-control-allow-origin"), null);
          assert.equal(await response.text(), "payload");
        },
      ],
      [
        "preflight is checked per side",
        async ({ base }) => {
          const fake = "00000000-0000-0000-0000-000000000000";

          const retrievePreflight = await fetch(`${base}/retrieve/${fake}`, {
            method: "OPTIONS",
            headers: {
              Origin: "https://retrieve.example.com",
              "Access-Control-Request-Method": "GET",
              "Access-Control-Request-Headers": "authorization",
            },
          });
          assert.equal(retrievePreflight.status, 204);
          assert.equal(
            retrievePreflight.headers.get("access-control-allow-origin"),
            "https://retrieve.example.com",
          );

          const retrieveWrongSide = await fetch(`${base}/retrieve/${fake}`, {
            method: "OPTIONS",
            headers: {
              Origin: "https://upload.example.com",
              "Access-Control-Request-Method": "GET",
            },
          });
          assert.equal(retrieveWrongSide.status, 403);

          const uploadPreflight = await fetch(`${base}/upload`, {
            method: "OPTIONS",
            headers: {
              Origin: "https://upload.example.com",
              "Access-Control-Request-Method": "POST",
            },
          });
          assert.equal(uploadPreflight.status, 204);
          assert.equal(
            uploadPreflight.headers.get("access-control-allow-origin"),
            "https://upload.example.com",
          );

          const uploadWrongSide = await fetch(`${base}/upload`, {
            method: "OPTIONS",
            headers: {
              Origin: "https://retrieve.example.com",
              "Access-Control-Request-Method": "POST",
            },
          });
          assert.equal(uploadWrongSide.status, 403);
        },
      ],
    ],
  );

  await runCase(
    "only upload filtered",
    8802,
    [
      "ALLOWED_UPLOAD_DOMAINS:upload.example.com",
      `MAX_PAYLOAD_BYTES:${MAX_PAYLOAD}`,
      `CHUNK_SIZE_BYTES:${CHUNK}`,
      `TTL_SECONDS:${TTL}`,
    ],
    [
      [
        "descriptor leaves retrieve open",
        async ({ base }) => {
          const body = await (await fetch(`${base}/`)).json();
          assert.deepEqual(body.filters.uploadDomains, ["upload.example.com"]);
          assert.equal(body.filters.retrieveDomains, "any");
        },
      ],
      [
        "upload blocks other origins but retrieve stays open",
        async ({ base }) => {
          const blocked = await upload(base, "payload", { Origin: "https://evil.test" });
          assert.equal(blocked.status, 403);

          const allowed = await upload(base, "payload", {
            Origin: "https://upload.example.com",
          });
          assert.equal(allowed.status, 201);
          assert.equal(
            allowed.headers.get("access-control-allow-origin"),
            "https://upload.example.com",
          );
          const info = await allowed.json();

          const download = await retrieve(base, info.token, {
            Origin: "https://evil.test",
          });
          assert.equal(download.status, 200);
          assert.equal(download.headers.get("access-control-allow-origin"), "*");
          assert.equal(await download.text(), "payload");
        },
      ],
      [
        "upload without Origin remains allowed",
        async ({ base }) => {
          const response = await upload(base, "payload");
          assert.equal(response.status, 201);
        },
      ],
    ],
  );

  await runCase(
    "only retrieve filtered",
    8803,
    [
      "ALLOWED_RETRIEVE_DOMAINS:retrieve.example.com",
      `MAX_PAYLOAD_BYTES:${MAX_PAYLOAD}`,
      `CHUNK_SIZE_BYTES:${CHUNK}`,
      `TTL_SECONDS:${TTL}`,
    ],
    [
      [
        "descriptor leaves upload open",
        async ({ base }) => {
          const body = await (await fetch(`${base}/`)).json();
          assert.equal(body.filters.uploadDomains, "any");
          assert.deepEqual(body.filters.retrieveDomains, ["retrieve.example.com"]);
        },
      ],
      [
        "upload is open but retrieve is not",
        async ({ base }) => {
          const uploaded = await upload(base, "payload", {
            Origin: "https://evil.test",
          });
          assert.equal(uploaded.status, 201);
          assert.equal(uploaded.headers.get("access-control-allow-origin"), "*");
          const info = await uploaded.json();

          const blocked = await retrieve(base, info.token, {
            Origin: "https://evil.test",
          });
          assert.equal(blocked.status, 403);

          const allowed = await retrieve(base, info.token, {
            Origin: "https://retrieve.example.com",
          });
          assert.equal(allowed.status, 200);
          assert.equal(
            allowed.headers.get("access-control-allow-origin"),
            "https://retrieve.example.com",
          );
          assert.equal(await allowed.text(), "payload");
        },
      ],
      [
        "retrieve without Origin remains allowed",
        async ({ base }) => {
          const uploaded = await upload(base, "payload");
          const info = await uploaded.json();
          const response = await retrieve(base, info.token);
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("access-control-allow-origin"), null);
          await response.text();
        },
      ],
    ],
  );
} catch (error) {
  console.error(`\nHarness error: ${error?.message || error}`);
  process.exitCode = 1;
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} side checks passed`);
if (failed.length > 0 || results.length === 0) {
  process.exitCode = 1;
}
