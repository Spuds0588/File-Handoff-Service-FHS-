/**
 * End-to-end test for FHS.
 *
 * Boots `wrangler dev` on 127.0.0.1:8799 with a small test configuration
 * (2 MB cap, 256 KB chunks, 5 s TTL, upload secret), exercises the public API
 * with fetch, and tears the server down. No Cloudflare account is required.
 *
 *   npm test
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.FHS_TEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "test-upload-secret";
const AUTH = { Authorization: `Bearer ${SECRET}` };
const MAX_PAYLOAD = 2 * 1024 * 1024;
const CHUNK = 256 * 1024;
const TTL = 5;

const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
assert.ok(
  fs.existsSync(WRANGLER),
  "wrangler is not installed. Run `npm install` first.",
);

let serverLog = "";
const server = spawn(
  process.execPath,
  [
    WRANGLER,
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(PORT),
    "--var",
    `UPLOAD_SECRET:${SECRET}`,
    "--var",
    `MAX_PAYLOAD_BYTES:${MAX_PAYLOAD}`,
    "--var",
    `CHUNK_SIZE_BYTES:${CHUNK}`,
    "--var",
    `TTL_SECONDS:${TTL}`,
  ],
  {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  },
);

server.stdout.on("data", (data) => {
  serverLog += data;
});
server.stderr.on("data", (data) => {
  serverLog += data;
});
server.on("error", (error) => {
  serverLog += `\nspawn error: ${error.message}`;
});

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

async function waitForServer() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`wrangler exited early with code ${server.exitCode}\n${serverLog}`);
    }
    try {
      const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`wrangler did not become ready within 120s\n${serverLog}`);
}

async function stopServer() {
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

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function upload(body, headers = {}) {
  return fetch(`${BASE}/upload`, {
    method: "POST",
    headers: { ...AUTH, ...headers },
    body,
  });
}

try {
  await waitForServer();
  console.log(`\nFHS end-to-end checks against ${BASE}\n`);

  await check("descriptor reports live configuration", async () => {
    const response = await fetch(`${BASE}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /application\/json/);
    assert.match(response.headers.get("cache-control") || "", /no-store/);
    const body = await response.json();
    assert.equal(body.retention, "zero-disk");
    assert.equal(body.conduit, "volatile-ram");
    assert.equal(body.routes.upload, "POST /upload");
    assert.equal(body.limits.maxPayloadBytes, MAX_PAYLOAD);
    assert.equal(body.limits.chunkSizeBytes, CHUNK);
    assert.equal(body.limits.ttlSeconds, TTL);
    assert.equal(body.filters.allowedContentTypes, "any");
    assert.equal(body.filters.allowedDomains, "any");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });

  await check("default CORS is wildcard and answers preflight", async () => {
    const response = await fetch(`${BASE}/upload`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://anywhere.test",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.match(response.headers.get("access-control-allow-methods") || "", /POST/);
  });

  await check("upload rejects a missing or wrong bearer token", async () => {
    const response = await fetch(`${BASE}/upload`, {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  });

  await check("multi-chunk round trip returns identical bytes", async () => {
    const payload = randomBytes(700 * 1024);
    const response = await upload(payload, { "Content-Type": "application/pdf" });
    assert.equal(response.status, 201);

    const info = await response.json();
    assert.match(info.token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(info.totalBytes, payload.byteLength);
    assert.ok(info.totalChunks >= 2, `expected multiple chunks, got ${info.totalChunks}`);
    assert.equal(info.contentType, "application/pdf");
    assert.equal(info.expiresInSeconds, TTL);
    assert.ok(info.handoffUrl.endsWith(`/retrieve/${info.token}`));
    assert.ok(Date.parse(info.expiresAt) > Date.now());

    const download = await fetch(info.handoffUrl);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/pdf");
    assert.equal(download.headers.get("x-handoff-status"), "Consumed-And-Wiped");
    assert.equal(download.headers.get("content-disposition"), "attachment");
    assert.match(download.headers.get("cache-control") || "", /no-store/);
    assert.match(download.headers.get("referrer-policy") || "", /no-referrer/);

    const received = Buffer.from(await download.arrayBuffer());
    assert.equal(received.byteLength, payload.byteLength);
    assert.equal(sha256(received), sha256(payload));
  });

  await check("a handoff URL is single-use (second GET is 410)", async () => {
    const payload = randomBytes(64 * 1024);
    const response = await upload(payload);
    assert.equal(response.status, 201);
    const { handoffUrl } = await response.json();

    const first = await fetch(handoffUrl);
    assert.equal(first.status, 200);
    await first.arrayBuffer();

    const second = await fetch(handoffUrl);
    assert.equal(second.status, 410);
  });

  await check("zero-byte uploads seal and retrieve cleanly", async () => {
    const response = await upload(new Uint8Array(0), { "Content-Type": "text/plain" });
    assert.equal(response.status, 201);
    const info = await response.json();
    assert.equal(info.totalBytes, 0);
    assert.equal(info.totalChunks, 0);

    const download = await fetch(info.handoffUrl);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "text/plain");
    assert.equal((await download.arrayBuffer()).byteLength, 0);

    const again = await fetch(info.handoffUrl);
    assert.equal(again.status, 410);
  });

  await check("malformed token is rejected with 400", async () => {
    const response = await fetch(`${BASE}/retrieve/not-a-token`);
    assert.equal(response.status, 400);
  });

  await check("unknown token is gone with 410", async () => {
    const response = await fetch(`${BASE}/retrieve/${randomUUID()}`);
    assert.equal(response.status, 410);
  });

  await check("payloads over the configured cap are rejected with 413", async () => {
    const response = await upload(randomBytes(MAX_PAYLOAD + 1024));
    assert.equal(response.status, 413);
  });

  await check("wrong method and unknown routes return 405 / 404", async () => {
    const wrongMethod = await fetch(`${BASE}/retrieve/${randomUUID()}`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");

    const missing = await fetch(`${BASE}/nope`);
    assert.equal(missing.status, 404);

    const uploadGet = await fetch(`${BASE}/upload`);
    assert.equal(uploadGet.status, 405);
  });

  await check("an unretrieved handoff expires after its TTL", async () => {
    const response = await upload(randomBytes(2048));
    assert.equal(response.status, 201);
    const { handoffUrl } = await response.json();

    await sleep(TTL * 1000 + 2500);
    const expired = await fetch(handoffUrl);
    assert.equal(expired.status, 410);
  });
} catch (error) {
  console.error(`\nHarness error: ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  await stopServer();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0 || results.length === 0) {
  process.exitCode = 1;
  console.error("\n--- wrangler log (tail) ---");
  console.error(serverLog.slice(-4000));
}
