/**
 * Filter tests: content-type allowlist, browser domain allowlist with CORS,
 * and the payload cap. Default-open behavior is covered by test/e2e.test.mjs.
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
const PORT = Number(process.env.FHS_FILTER_PORT || 8800);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "filter-secret";
const AUTH = { Authorization: `Bearer ${SECRET}` };
const MAX_PAYLOAD = 1024 * 1024;
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
    "--var",
    "ALLOWED_CONTENT_TYPES:application/pdf,image/*",
    "--var",
    "ALLOWED_DOMAINS:app.example.com,*.trusted.test",
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

async function upload(body, headers = {}) {
  return fetch(`${BASE}/upload`, {
    method: "POST",
    headers: { ...AUTH, ...headers },
    body,
  });
}

try {
  await waitForServer();
  console.log(`\nFHS filter checks against ${BASE}\n`);

  await check("descriptor reports configured filters", async () => {
    const response = await fetch(`${BASE}/`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.filters.allowedContentTypes, ["application/pdf", "image/*"]);
    assert.deepEqual(body.filters.allowedDomains, ["app.example.com", "*.trusted.test"]);
  });

  await check("rejects a content type outside the allowlist", async () => {
    const response = await upload("hello", { "Content-Type": "text/plain" });
    assert.equal(response.status, 415);
  });

  await check("accepts a wildcard content type and echoes an allowed origin", async () => {
    const response = await upload("png", {
      "Content-Type": "image/png",
      Origin: "https://app.example.com",
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.match(response.headers.get("vary") || "", /Origin/);
    const info = await response.json();
    await fetch(info.handoffUrl);
  });

  await check("blocks a browser origin outside the allowlist", async () => {
    const response = await upload("pdf", {
      "Content-Type": "application/pdf",
      Origin: "https://evil.test",
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });

  await check("matches wildcard subdomains and applies CORS to retrieve", async () => {
    const response = await upload("pdf", {
      "Content-Type": "application/pdf",
      Origin: "https://api.trusted.test",
    });
    assert.equal(response.status, 201);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      "https://api.trusted.test",
    );

    const info = await response.json();
    const download = await fetch(info.handoffUrl, {
      headers: { Origin: "https://api.trusted.test" },
    });
    assert.equal(download.status, 200);
    assert.equal(
      download.headers.get("access-control-allow-origin"),
      "https://api.trusted.test",
    );
    assert.equal(await download.text(), "pdf");
  });

  await check("does not match the apex of a wildcard domain", async () => {
    const response = await upload("pdf", {
      "Content-Type": "application/pdf",
      Origin: "https://trusted.test",
    });
    assert.equal(response.status, 403);
  });

  await check("allows server-to-server requests with no Origin", async () => {
    const response = await upload("pdf", { "Content-Type": "application/pdf" });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const info = await response.json();
    await fetch(info.handoffUrl);
  });

  await check("uses Referer when Origin is absent", async () => {
    const response = await upload("pdf", {
      "Content-Type": "application/pdf",
      Referer: "https://app.example.com/send",
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.com");
    const info = await response.json();
    await fetch(info.handoffUrl);
  });

  await check("answers preflight for an allowed origin and rejects others", async () => {
    const allowed = await fetch(`${BASE}/upload`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.match(allowed.headers.get("access-control-allow-methods") || "", /POST/);
    assert.match(allowed.headers.get("access-control-allow-headers") || "", /Authorization/i);

    const blocked = await fetch(`${BASE}/upload`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.test",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(blocked.status, 403);
  });

  await check("keeps CORS headers on a rejected content type", async () => {
    const response = await upload("x", {
      "Content-Type": "text/plain",
      Origin: "https://app.example.com",
    });
    assert.equal(response.status, 415);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.com");
  });

  await check("enforces the payload cap", async () => {
    const response = await upload(new Uint8Array(MAX_PAYLOAD + 1), {
      "Content-Type": "application/pdf",
    });
    assert.equal(response.status, 413);
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
