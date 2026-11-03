# File Handoff Service (FHS)

An ephemeral, single-use, zero-retention binary relay built on Cloudflare Workers and Durable Objects. It bridges two decoupled backend systems (Service A and Service B) that need to exchange Nonpublic Personal Information (NPI), Protected Health Information (PHI), or confidential artifacts without a shared bucket, database, or storage provider.

**Site:** https://spuds0588.github.io/File-Handoff-Service-FHS-/

- Upload once, download once. The second request for a handoff URL returns HTTP 410.
- Payloads exist only in the memory of isolated Durable Objects. No R2, KV, D1, or Durable Object storage.
- 25 MB default payload, 60 second default TTL, both configurable.
- Chunked streaming in both directions, so no isolate holds the whole file.
- Optional bearer token on upload. No payload contents in logs.

## Deploy in one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Spuds0588/File-Handoff-Service-FHS-)

The button clones this repository into your GitHub account, provisions the `HANDOFF_VAULT`
Durable Object, and deploys the Worker to a `workers.dev` URL.

There are no required fields: the Durable Object binding and the `v1` migration come from
`wrangler.jsonc`, so the first deploy works as-is. Uploads are open until you set
`UPLOAD_SECRET`, which is the first thing to do:

```bash
npx wrangler secret put UPLOAD_SECRET   # any long random string, e.g. openssl rand -hex 32
```

Uploads then send it as `Authorization: Bearer <secret>`. If you skip this, anyone who finds the
URL can use the relay until the TTL drops the bytes.

When the deploy finishes, copy the base URL and confirm it:

```bash
export FHS=https://file-handoff-service.YOUR-SUBDOMAIN.workers.dev
curl -sS "$FHS/"
```

## How it works

```
Service A ── POST /upload ──▶ Worker ── 8 MB chunks ──▶ Durable Objects (volatile RAM)
     ◀── 201 { handoffUrl } ──┘                                   │
                                                                 │ TTL 60 s
Service B ── GET /retrieve/:token ───────────────────────────────▶│
     ◀── 200 stream, token burned, bytes dropped ────────────────┘
```

1. `POST /upload` streams the body and writes 8 MB chunks into separate Durable Objects.
2. A layout record is written last. That seals the handoff, starts the TTL clock, and produces the token.
3. `GET /retrieve/:token` burns the layout record, pulls chunks in order, and streams them out.
4. Any later request returns 410. Unread chunks are zeroed when their timer fires.

## Quick start (local, no account)

```bash
git clone https://github.com/Spuds0588/File-Handoff-Service-FHS-.git fhs
cd fhs
npm install
npm test        # boots wrangler dev on 127.0.0.1:8799 and exercises the API
npm run dev     # manual local server on 127.0.0.1:8787
```

## Deploy from the CLI

Requires Node 20.3+ and a Cloudflare account (the free plan is enough). The result is the same
as the button, without cloning the repository into your GitHub account.

```bash
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` prints `https://file-handoff-service.<subdomain>.workers.dev`. The Durable Object binding and the `v1` migration are already in `wrangler.jsonc`; there is nothing to create by hand.

Then set the upload secret so the endpoint is not open:

```bash
npx wrangler secret put UPLOAD_SECRET
```

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | JSON descriptor: version, routes, live limits. |
| `POST` | `/upload` | Request body is the file. `201` with `token`, `handoffUrl`, `contentType`, `totalBytes`, `totalChunks`, `expiresInSeconds`, `expiresAt`. |
| `GET` | `/retrieve/:token` | Streams the payload once. `410` afterwards. |

Example:

```bash
export FHS=https://file-handoff-service.YOUR-SUBDOMAIN.workers.dev

curl -sS -X POST "$FHS/upload" \
  -H "Content-Type: application/pdf" \
  --data-binary @report.pdf

# -> {"token":"…","handoffUrl":"…/retrieve/…","expiresInSeconds":60, …}

curl -sS "$FHS/retrieve/<token>" -o report.pdf
```

Status codes: `201` sealed, `400` malformed token, `401` upload secret required, `405` wrong method, `410` expired or consumed, `413` over the payload cap, `500` internal error.

## Configuration

Set plain values under `vars` in `wrangler.jsonc` and redeploy. Use `npx wrangler secret put UPLOAD_SECRET` for the secret; it is never committed.

| Variable | Default | Range / notes |
| --- | --- | --- |
| `TTL_SECONDS` | `60` | 5–3600. Starts when the upload is sealed. |
| `MAX_PAYLOAD_BYTES` | `26214400` (25 MB) | Up to `94371840` (90 MB). |
| `CHUNK_SIZE_BYTES` | `8388608` (8 MB) | 64 KB–16 MB, one Durable Object per chunk. |
| `UPLOAD_SECRET` | unset | When set, uploads need `Authorization: Bearer <secret>`. |

## Security model

- **Single use.** The first successful `GET /retrieve/:token` consumes the handoff. Tokens are random UUIDs (122 bits).
- **No durable storage.** Nothing in the code path touches R2, KV, D1, or `state.storage`.
- **No payload logging.** Only token prefixes, byte counts, and statuses are logged.
- **Header hardening.** Every response is `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`; retrieved files are served as `attachment`.
- **Upload gate.** `UPLOAD_SECRET` is optional, but set it on a public deployment so nobody can use your relay as free storage.

## Honest limits

- **Not durable.** A Durable Object can be evicted while idle, and timers do not survive eviction. A payload may disappear before its TTL. Treat `410` as "upload it again"; FHS is a relay, not a queue.
- **Not a guarantee of physical erasure.** FHS drops its references and zeroes chunks that expire unread, but it cannot prove that every copy inside the V8 heap or OS was overwritten. The guarantee is that the service never persists payloads and retains no reference after delivery or expiry.
- **No payload authentication.** Anyone holding the handoff URL can download once. Deliver it over your own trusted channel, server to server.
- **No built-in rate limiting.** Put Cloudflare WAF/rate limiting in front of `/upload` for public deployments.
- **Compliance is yours.** The architecture removes a stored-data surface, but HIPAA, GLBA, and GDPR obligations cover your whole system, agreements included. FHS is not a certification.

## Project layout

```
index.html, assets/, robots.txt, sitemap.xml, llms.txt   static site served by GitHub Pages
src/index.js                                             Worker + Durable Object
test/e2e.test.mjs                                        end-to-end suite (wrangler dev)
wrangler.jsonc                                           bindings, migration, vars
AGENTS.md                                                rules for agents working in this repo
todo.md, history.md                                      backlog and work log
```

The homepage is served by GitHub Pages from `main` at the repository root (`.nojekyll` disables Jekyll). Keep site asset URLs relative so the project path keeps working.

## License

MIT © 2026 Corey Burns
