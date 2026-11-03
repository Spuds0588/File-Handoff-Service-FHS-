/**
 * File Handoff Service (FHS) — v1
 *
 * An ephemeral, single-use, zero-retention binary relay built on Cloudflare
 * Workers and Durable Objects.
 *
 * Bytes live only in the memory of isolated Durable Objects. FHS never calls
 * R2, KV, D1, or Durable Object storage, so there is no durable copy of a
 * payload anywhere in the service.
 *
 * Routes
 *   GET  /                 Service descriptor (JSON)
 *   POST /upload           Ingest a binary payload, return a single-use URL
 *   GET  /retrieve/:token  Stream the payload once, then drop it
 *
 * Design notes:
 *   - Uploads stream in and are split into chunks, one Durable Object each, so
 *     neither the Worker nor a single DO has to hold the whole file.
 *   - The TTL clock starts when the upload is sealed (metadata is written
 *     last). Orphaned chunks from a failed upload get a short grace period.
 *   - A handoff token is a random UUID (122 bits). The first successful GET
 *     consumes it; every later GET returns 410.
 */

const DEFAULTS = {
  maxPayloadBytes: 25 * 1024 * 1024, // 25 MiB
  chunkSizeBytes: 8 * 1024 * 1024, // 8 MiB per Durable Object
  ttlSeconds: 60,
};

// Workers Free/Pro cap request bodies at 100 MB; keep headroom for framing
// and for the isolate memory ceiling.
const HARD_MAX_PAYLOAD_BYTES = 90 * 1024 * 1024;
const MIN_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_CHUNKS = 4096;

// Chunks from an upload that never sealed are zeroed after TTL + this grace.
const ORPHAN_GRACE_MS = 2 * 60 * 1000;

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMON_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function intVar(raw, fallback, min, max) {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function readConfig(env) {
  const ttlSeconds = intVar(env?.TTL_SECONDS, DEFAULTS.ttlSeconds, 5, 3600);
  return {
    ttlSeconds,
    ttlMs: ttlSeconds * 1000,
    maxPayloadBytes: intVar(
      env?.MAX_PAYLOAD_BYTES,
      DEFAULTS.maxPayloadBytes,
      1024,
      HARD_MAX_PAYLOAD_BYTES,
    ),
    chunkSizeBytes: intVar(
      env?.CHUNK_SIZE_BYTES,
      DEFAULTS.chunkSizeBytes,
      MIN_CHUNK_BYTES,
      MAX_CHUNK_BYTES,
    ),
  };
}

/** Never echo an unsanitized header value back to a client. */
function readContentType(request) {
  const raw = (request.headers.get("Content-Type") || "")
    .replace(/[\r\n]/g, "")
    .trim()
    .slice(0, 200);
  return /^[\w.+-]+\/[\w.+-]+/.test(raw) ? raw : "application/octet-stream";
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function methodNotAllowed(allow) {
  return json({ error: `Method not allowed. Use ${allow}.` }, 405, { Allow: allow });
}

/** Constant-time comparison for the optional upload secret. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function chunkStub(env, token, index) {
  return env.HANDOFF_VAULT.get(env.HANDOFF_VAULT.idFromName(`${token}_chunk_${index}`));
}

function metaStub(env, token) {
  return env.HANDOFF_VAULT.get(env.HANDOFF_VAULT.idFromName(`${token}_meta`));
}

/** Best-effort wipe of chunks that will never be delivered. */
async function purgeChunks(env, token, indices) {
  await Promise.allSettled(
    indices.map((index) =>
      chunkStub(env, token, index).fetch("https://internal/purge", { method: "POST" }),
    ),
  );
}

const ROUTES = {
  descriptor: "GET /",
  upload: "POST /upload",
  retrieve: "GET /retrieve/:token",
};

function descriptor(origin, cfg) {
  return {
    service: "File Handoff Service (FHS)",
    version: "1.0.0",
    status: "operational",
    conduit: "volatile-ram",
    retention: "zero-disk",
    origin,
    routes: ROUTES,
    limits: {
      maxPayloadBytes: cfg.maxPayloadBytes,
      chunkSizeBytes: cfg.chunkSizeBytes,
      ttlSeconds: cfg.ttlSeconds,
    },
    notes: [
      "Payloads are held only in Durable Object memory and dropped on first read or TTL expiry.",
      "A handoff URL is single-use: the second GET returns HTTP 410.",
      "No payload is ever written to R2, KV, D1, or Durable Object storage.",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* POST /upload                                                        */
/* ------------------------------------------------------------------ */

async function handleUpload(request, env, cfg, origin) {
  if (env.UPLOAD_SECRET) {
    const auth = request.headers.get("Authorization") || "";
    if (!safeEqual(auth, `Bearer ${env.UPLOAD_SECRET}`)) {
      return json(
        {
          error:
            "Unauthorized. POST /upload requires 'Authorization: Bearer <UPLOAD_SECRET>'.",
        },
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }
  }

  const declaredLength = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > cfg.maxPayloadBytes) {
    return json(
      { error: `Payload too large. Maximum ${cfg.maxPayloadBytes} bytes.` },
      413,
    );
  }

  const token = crypto.randomUUID();
  const contentType = readContentType(request);
  const storedChunks = [];

  let chunkIndex = 0;
  let totalBytes = 0;
  let staged = [];
  let stagedBytes = 0;

  const flushChunk = async () => {
    const merged = new Uint8Array(stagedBytes);
    let offset = 0;
    for (const part of staged) {
      merged.set(part, offset);
      offset += part.byteLength;
    }

    const index = chunkIndex;
    const response = await chunkStub(env, token, index).fetch("https://internal/store-chunk", {
      method: "POST",
      body: merged,
    });
    if (!response.ok) {
      throw new Error(`Vault rejected chunk ${index} (HTTP ${response.status}).`);
    }

    storedChunks.push(index);
    chunkIndex += 1;
    staged = [];
    stagedBytes = 0;
  };

  try {
    const reader = request.body?.getReader();

    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();

        if (value?.byteLength) {
          totalBytes += value.byteLength;
          if (totalBytes > cfg.maxPayloadBytes) {
            await reader.cancel().catch(() => {});
            await purgeChunks(env, token, storedChunks);
            return json(
              { error: `Payload too large. Maximum ${cfg.maxPayloadBytes} bytes.` },
              413,
            );
          }
          staged.push(value);
          stagedBytes += value.byteLength;

          if (stagedBytes >= cfg.chunkSizeBytes) await flushChunk();
        }

        if (done) break;
      }
    }

    if (stagedBytes > 0) await flushChunk();

    const sealed = await metaStub(env, token).fetch("https://internal/store-meta", {
      method: "POST",
      body: JSON.stringify({ totalParts: chunkIndex, totalBytes, contentType }),
    });
    if (!sealed.ok) {
      throw new Error(`Vault rejected metadata (HTTP ${sealed.status}).`);
    }

    console.log(
      `[FHS][INGEST] sealed ${token.slice(0, 8)}… ${totalBytes} bytes across ${chunkIndex} chunk(s)`,
    );

    return json(
      {
        token,
        handoffUrl: `${origin}/retrieve/${token}`,
        contentType,
        totalBytes,
        totalChunks: chunkIndex,
        expiresInSeconds: cfg.ttlSeconds,
        expiresAt: new Date(Date.now() + cfg.ttlMs).toISOString(),
      },
      201,
    );
  } catch (error) {
    console.error(`[FHS][INGEST] failed: ${error?.message || error}`);
    await purgeChunks(env, token, storedChunks).catch(() => {});
    return json({ error: "Upload failed and the partial handoff was purged." }, 500);
  }
}

/* ------------------------------------------------------------------ */
/* GET /retrieve/:token                                                */
/* ------------------------------------------------------------------ */

async function handleRetrieve(token, env) {
  if (!TOKEN_RE.test(token)) {
    return json({ error: "Invalid or missing handoff token." }, 400);
  }

  const metadataResponse = await metaStub(env, token).fetch("https://internal/fetch-meta");
  if (!metadataResponse.ok) {
    return json({ error: "Payload expired, already retrieved, or does not exist." }, 410);
  }

  let meta;
  try {
    meta = await metadataResponse.json();
  } catch {
    return json({ error: "Payload metadata was unreadable and has been dropped." }, 410);
  }

  const totalParts = Number.isInteger(meta?.totalParts) ? meta.totalParts : 0;
  const totalBytes = Number.isInteger(meta?.totalBytes) ? meta.totalBytes : 0;
  const contentType =
    typeof meta?.contentType === "string" && meta.contentType.length <= 200
      ? meta.contentType
      : "application/octet-stream";

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  // Pull chunks one at a time so the gateway isolate never holds the payload.
  (async () => {
    let index = 0;
    try {
      for (; index < totalParts; index += 1) {
        const response = await chunkStub(env, token, index).fetch("https://internal/fetch-chunk");
        if (!response.ok) throw new Error(`Chunk ${index} is no longer available.`);
        await writer.write(new Uint8Array(await response.arrayBuffer()));
      }
      await writer.close();
      console.log(`[FHS][RETRIEVE] delivered ${token.slice(0, 8)}… ${totalBytes} bytes`);
    } catch (error) {
      console.error(`[FHS][RETRIEVE] stream aborted at chunk ${index}: ${error?.message || error}`);
      const remaining = [];
      for (let i = index; i < totalParts; i += 1) remaining.push(i);
      await purgeChunks(env, token, remaining).catch(() => {});
      await writer.abort(error).catch(() => {});
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": contentType,
      "Content-Length": String(totalBytes),
      "Content-Disposition": "attachment",
      "X-Handoff-Status": "Consumed-And-Wiped",
    },
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfg = readConfig(env);

    console.log(`[FHS][ROUTER] ${request.method} ${url.pathname}`);

    try {
      if (url.pathname === "/" || url.pathname === "") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return json(descriptor(url.origin, cfg));
      }

      if (url.pathname === "/upload") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await handleUpload(request, env, cfg, url.origin);
      }

      if (url.pathname.startsWith("/retrieve/")) {
        const token = url.pathname.slice("/retrieve/".length);
        if (request.method !== "GET") return methodNotAllowed("GET");
        return await handleRetrieve(token, env);
      }

      return json({ error: "Not found.", routes: ROUTES }, 404);
    } catch (error) {
      console.error(`[FHS][ERROR] ${request.method} ${url.pathname}: ${error?.stack || error}`);
      return json({ error: "Internal error." }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Durable Object: an isolated, volatile vault                         */
/* ------------------------------------------------------------------ */

export class HandoffVault {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.buffer = null; // Uint8Array for a chunk
    this.meta = null; // layout record for a sealed handoff
    this.consumed = false;
    this.expiresAt = 0;
    this.timer = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const cfg = readConfig(this.env);

    switch (url.pathname) {
      case "/store-meta":
        return this.storeMeta(request, cfg);
      case "/fetch-meta":
        return this.fetchMeta();
      case "/store-chunk":
        return this.storeChunk(request, cfg);
      case "/fetch-chunk":
        return this.fetchChunk();
      case "/purge":
        this.wipe("Operator-Purge");
        return new Response("OK");
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  async storeMeta(request, cfg) {
    if (this.consumed || this.meta) return new Response("Vault already sealed", { status: 409 });

    let meta;
    try {
      meta = await request.json();
    } catch {
      return new Response("Invalid metadata", { status: 400 });
    }

    const totalParts = Number(meta?.totalParts);
    const totalBytes = Number(meta?.totalBytes);
    if (!Number.isInteger(totalParts) || totalParts < 0 || totalParts > MAX_TOTAL_CHUNKS) {
      return new Response("Invalid chunk count", { status: 400 });
    }
    if (
      !Number.isInteger(totalBytes) ||
      totalBytes < 0 ||
      totalBytes > HARD_MAX_PAYLOAD_BYTES
    ) {
      return new Response("Invalid byte count", { status: 400 });
    }

    this.meta = {
      totalParts,
      totalBytes,
      contentType:
        typeof meta?.contentType === "string" && meta.contentType.length <= 200
          ? meta.contentType
          : "application/octet-stream",
    };
    this.arm(cfg.ttlMs);
    return new Response("OK");
  }

  fetchMeta() {
    if (this.consumed || !this.meta) return new Response("Gone", { status: 410 });
    if (this.isExpired()) {
      this.wipe("TTL-Expired-Meta");
      return new Response("Gone", { status: 410 });
    }

    const body = JSON.stringify(this.meta);
    this.wipe("Metadata-Consumed");
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  }

  async storeChunk(request, cfg) {
    if (this.consumed || this.buffer) return new Response("Chunk collision", { status: 409 });

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_CHUNK_BYTES + 1024 * 1024) {
      return new Response("Chunk too large", { status: 413 });
    }

    this.buffer = bytes;
    this.arm(cfg.ttlMs + ORPHAN_GRACE_MS);
    return new Response("OK");
  }

  fetchChunk() {
    if (this.consumed || !this.buffer) return new Response("Gone", { status: 410 });
    if (this.isExpired()) {
      this.wipe("TTL-Expired-Chunk");
      return new Response("Gone", { status: 410 });
    }

    // Hand ownership of the bytes to the outbound response and drop our
    // reference right away. We cannot zero a buffer that is still being sent,
    // and the runtime may already have copied it; the guarantee FHS makes is
    // that the service retains nothing after delivery.
    const outgoing = this.buffer;
    this.buffer = null;
    this.release();
    return new Response(outgoing);
  }

  isExpired() {
    return this.expiresAt > 0 && Date.now() > this.expiresAt;
  }

  arm(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    this.expiresAt = Date.now() + delayMs;
    this.timer = setTimeout(() => this.wipe("TTL-Expired"), delayMs);
  }

  release() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.expiresAt = 0;
    this.meta = null;
    this.consumed = true;
  }

  /** Overwrite anything never delivered, then drop every reference. */
  wipe(reason) {
    let wipedBytes = 0;
    if (this.buffer) {
      wipedBytes = this.buffer.byteLength;
      this.buffer.fill(0);
      this.buffer = null;
    }
    this.release();
    console.log(`[FHS][VAULT] wiped (${reason}): zeroed ${wipedBytes} retained byte(s)`);
  }
}
