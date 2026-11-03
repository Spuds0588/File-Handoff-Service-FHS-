# File Handoff Service (FHS)

An ephemeral, single-use, zero-retention binary relay built on Cloudflare Workers and Durable Objects. It bridges two decoupled backend systems (Service A and Service B) that need to exchange Nonpublic Personal Information (NPI), Protected Health Information (PHI), or confidential artifacts without a shared bucket, database, or storage provider.

**Site:** https://spuds0588.github.io/File-Handoff-Service-FHS-/

- Upload once, download once. The second request for a handoff URL returns HTTP 410.
- Payloads exist only in the memory of isolated Durable Objects. No R2, KV, D1, or Durable Object storage.
- 25 MB default payload, 60 second default TTL, both configurable.
- Chunked streaming in both directions, so no isolate holds the whole file.
- Optional bearer tokens on upload and retrieve. No payload contents in logs.
- Independent, open-by-default controls for both sides: per-side browser origins and optional bearer secrets, plus upload-only size and MIME filters.

## Deploy

Three ways to get the same Worker:

- **One click** — the button clones the repo into your GitHub account and deploys from the dashboard.
- **Setup script** — no clone into your project; a temporary checkout, with secrets outside the repo.
- **CLI** — clone locally, log in, and deploy.

### First deploy on a new Cloudflare account

A fresh account has no `workers.dev` subdomain until Workers & Pages has been opened once. If
`wrangler deploy` fails with code `10063`, that is the missing prerequisite, not a problem with
the Worker. Open **Workers & Pages** in the dashboard once, or create it with an API token:

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"subdomain":"your-name"}'
```

The setup script can check or create the subdomain with `--subdomain your-name` when
`CLOUDFLARE_API_TOKEN` is set. It cannot reuse Wrangler's OAuth token for that API call; with
`wrangler login`, open Workers & Pages once instead.

A new subdomain can also reject TLS for up to a minute after the first deploy while its edge
certificate is issued. DNS may resolve before HTTPS works; retry the smoke check rather than
redeploying.

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Spuds0588/File-Handoff-Service-FHS-)

The button clones this repository into your GitHub account, provisions the `HANDOFF_VAULT`
Durable Object, and deploys the Worker to a `workers.dev` URL.

There are no required fields: the Durable Object binding and the `v1` migration come from
`wrangler.jsonc`, so the first deploy works as-is. Uploads and retrievals are open until you set
the optional secrets. Gate both directions, or only the side you need:

```bash
npx wrangler secret put UPLOAD_SECRET    # POST /upload
npx wrangler secret put RETRIEVE_SECRET  # GET /retrieve/:token
```

Each side sends its secret as `Authorization: Bearer <secret>`. If you skip one, that side stays
open: anyone who finds the URL can use it until the TTL drops the bytes. Set neither for an open
relay, or one for a one-sided gate.

When the deploy finishes, copy the base URL and confirm it:

```bash
export FHS=https://file-handoff-service.YOUR-SUBDOMAIN.workers.dev
curl -sS "$FHS/"
```

### Setup script (no clone into your project)

If an agent is already inside another project and must not clone this one, run the setup script.
It checks out FHS into a temporary directory, deploys it, sets the upload secret, verifies a real
handoff, and deletes the checkout. Nothing is written into your project.

```bash
curl -fsSL https://raw.githubusercontent.com/Spuds0588/File-Handoff-Service-FHS-/main/scripts/setup.mjs -o /tmp/fhs-setup.mjs
node /tmp/fhs-setup.mjs --dry-run   # prints the plan, changes nothing
node /tmp/fhs-setup.mjs
```

Requires Node 20.3+, git, and `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` in the environment).
The generated upload secret is stored at `~/.fhs/upload-secret` with mode 600, outside your
repository, and its value is never printed. Set `UPLOAD_SECRET` in the environment to use your own
value; `FHS_SECRET_FILE` changes the location. `RETRIEVE_SECRET`, if set in the environment, is
used only for the live retrieve check; the script does not set it. Add it with
`wrangler secret put` to gate retrieval.

Useful flags:

- `--repo <url|path>` deploys from a remote repository or a local checkout. It is the flag that
  keeps an agent from cloning FHS into the project it is working in.
- `--config <file>` deploys one of the duplicate profiles described below. The path must be
  inside the checkout.
- `--no-upload-secret` leaves uploads open on a fresh Worker. It skips setting the secret; it does
  not delete an existing `UPLOAD_SECRET`, so a redeploy of a gated Worker stays gated.
- `--subdomain <name>` checks or creates the `workers.dev` subdomain. It requires
  `CLOUDFLARE_API_TOKEN`; with OAuth login, use the dashboard once instead.
- `--keep` keeps the temporary checkout for inspection, and `--ref` deploys a branch or tag other
  than `main`.

The verifier reads `GET /` first and uses the deployment's actual MIME allowlist for its upload
probe, so a filtered profile can still be verified. If the deployment rejects that probe (`415`),
or retrieval requires a `RETRIEVE_SECRET` you did not provide (`401`), the script reports
“deployed; verification skipped” instead of calling the deployment a failure.

### Where secrets live

- `UPLOAD_SECRET` and `RETRIEVE_SECRET` are Worker secrets. The setup script sets the upload
  secret; set the retrieve secret with `wrangler secret put` when needed. Neither is written to
  `wrangler.jsonc` or any committed file.
- `CLOUDFLARE_API_TOKEN`, if used, is read from the environment.
- `.dev.vars` is local-only and gitignored; `.dev.vars.example` is a template with no value.

### From the CLI

Requires Node 20.3+ and a Cloudflare account (the free plan is enough). From a local clone (see
[Quick start](#quick-start-local-no-account)), run:

```bash
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` prints `https://file-handoff-service.<subdomain>.workers.dev`. Then set either
or both bearer secrets:

```bash
npx wrangler secret put UPLOAD_SECRET
npx wrangler secret put RETRIEVE_SECRET
```

### Custom deployment profiles

Wrangler does not merge configuration files: an `extends` field is rejected, and the deploy then
has no entry point. A second profile must repeat `main`, the `HANDOFF_VAULT` binding, and the
`v1` migration. [`deploy/pdf-only.jsonc`](deploy/pdf-only.jsonc) is a complete example that keeps
the same Worker name and applies a declared-MIME PDF filter. Change `name` if you want a separate
Worker instead of updating the default one.

[`deploy/simplepdf.jsonc`](deploy/simplepdf.jsonc) pins the current production settings for the
SimplePDF deployment: a 300-second TTL, the PDF signature check, and only SimplePDF retrieve
origins. Use that profile only for the deployment it describes; the PDF-only profile is the
generic starting point.

```bash
npx wrangler dev --config deploy/pdf-only.jsonc
npx wrangler deploy --config deploy/pdf-only.jsonc
npx wrangler deploy --config deploy/simplepdf.jsonc
node scripts/setup.mjs --repo . --config deploy/pdf-only.jsonc
```

The setup script's `--config` path is relative to its checkout. Use a local `--repo .` when the
profile exists only in your working copy.

## Shut it down

Deleting the Worker stops requests immediately and drops any payloads still held in memory. FHS
never writes payloads to durable storage, so there is no bucket, database, or object store to
empty.

For the default Worker:

```bash
npx wrangler delete
```

For a profile:

```bash
npx wrangler delete --config deploy/pdf-only.jsonc
npx wrangler delete --config deploy/simplepdf.jsonc
```

The same action is in **Workers & Pages → select the Worker → Settings → Delete**. Deleting the
Worker removes its route and makes its Worker-scoped secrets unusable. If Cloudflare reports that
the Worker is still referenced by a Durable Object namespace, remove that namespace under
**Workers & Pages → Durable Objects** and retry. The namespace is only the container for FHS's
classes; FHS never writes payloads to Durable Object storage.

A custom domain and the account-wide `workers.dev` subdomain are separate resources. Do not delete
the subdomain just to remove one Worker: it affects every Worker on the account. For most
deployments, deleting the Worker is sufficient.

If the setup script generated a local secret at `~/.fhs/upload-secret`, remove that file when the
service is gone: `rm -f ~/.fhs/upload-secret`.

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
npm test        # setup dry-run + end-to-end, filter, and side suites (default ports :8799-:8803)
npm run dev     # manual local server on 127.0.0.1:8787
```

Each suite also runs alone: `npm run test:setup`, `test:e2e`, `test:filters`, or `test:sides`.
The defaults are `8799`, `8800`, and `8801`–`8803`; override them with `FHS_TEST_PORT`,
`FHS_FILTER_PORT`, and `FHS_SIDES_PORT` (the last is the base port, plus 0–2).

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | JSON descriptor: version, routes, limits, and filters. |
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

Status codes: `201` sealed, `400` malformed token, `401` upload or retrieve secret required, `403` disallowed browser origin, `405` wrong method, `410` expired or consumed, `413` over the payload cap, `415` disallowed content type, `500` internal error.

`409` exists only between the Worker and a Durable Object (an already-sealed vault or a chunk
collision); the public upload path catches it, purges partial chunks, and returns `500`. A
retrieval that fails after the `200` headers is a truncated body or network error to the client,
not a later `500` response.

## Configuration

Set plain values under `vars` in the active config (`wrangler.jsonc` by default) and redeploy. Use
`npx wrangler secret put <NAME>` for secrets; they are never committed.

| Variable | Default | Range / notes |
| --- | --- | --- |
| `TTL_SECONDS` | `60` | 5–3600. Starts when the upload is sealed. |
| `MAX_PAYLOAD_BYTES` | `26214400` (25 MB) | Up to `94371840` (90 MB). Upload only. |
| `CHUNK_SIZE_BYTES` | `8388608` (8 MB) | 64 KB–16 MB, one Durable Object per chunk. |
| `ALLOWED_CONTENT_TYPES` | unset (any) | Comma-separated declared MIME types; `image/*` wildcard; blocked uploads get `415`. Upload only; the declared value is echoed on retrieve. |
| `REQUIRE_PDF_MAGIC` | unset (false) | `true`, `1`, or `yes` requires uploads declared `application/pdf` to begin with `%PDF-`; blocked uploads get `415`. Upload only. |
| `ALLOWED_UPLOAD_DOMAINS` | unset (any) | Upload-only browser Origin/Referer hostnames; `*.example.com` wildcard; blocked uploads get `403`. |
| `ALLOWED_RETRIEVE_DOMAINS` | unset (any) | Retrieve-only browser Origin/Referer hostnames; `*.example.com` wildcard; blocked retrievals get `403`. |
| `UPLOAD_SECRET` | unset | When set, uploads need `Authorization: Bearer <secret>`; retrieval is unaffected. |
| `RETRIEVE_SECRET` | unset | When set, retrievals need `Authorization: Bearer <secret>`; upload is unaffected. |

### Filters

The two sides are independent. With nothing configured, both are open. Set only the upload
controls, only the retrieve controls, or both:

```jsonc
"vars": {
  "MAX_PAYLOAD_BYTES": "10485760",
  "ALLOWED_CONTENT_TYPES": "application/pdf,image/*",
  "REQUIRE_PDF_MAGIC": "true",
  "ALLOWED_UPLOAD_DOMAINS": "app.example.com,*.example.org",
  "ALLOWED_RETRIEVE_DOMAINS": "consumer.example.org"
}
```

```bash
npx wrangler secret put UPLOAD_SECRET    # POST /upload
npx wrangler secret put RETRIEVE_SECRET  # GET /retrieve/:token
```

| Upload side | Retrieve side | Result |
| --- | --- | --- |
| unset | unset | Open relay; possession of the handoff URL is enough to retrieve once. |
| set | unset | Uploads are gated; anyone with the token can retrieve once. |
| unset | set | Anyone can upload; retrieval requires the configured gate. |
| set | set | Both directions are gated. |

### What each control constrains

Domain lists are browser controls, not a security boundary. That sentence is easy to read as
“the domain list does nothing”; the useful question is which consumer it can see at all:

| Consumer | What constrains it | What does not |
| --- | --- | --- |
| A page fetching the handoff (a web editor, for example) | `ALLOWED_*_DOMAINS`: the browser sends the page's real `Origin`; a blocked one gets `403` and no CORS | a User-Agent list; FHS never checks one |
| A backend or proxy fetching the handoff | the handoff token, plus `RETRIEVE_SECRET` if set; it sends no `Origin`, so the domain list is inert | both domain allowlists |
| A person pasting the URL into the address bar | the handoff token only; browsers cannot attach `Authorization`, so `RETRIEVE_SECRET` makes the URL unusable there | both domain allowlists and `RETRIEVE_SECRET` |

The same split applies on upload. A browser page is the only consumer a domain allowlist can
distinguish; a non-browser client can omit or forge the header. Use the bearer secrets when the
caller must be authorized rather than merely constrained.

- `ALLOWED_UPLOAD_DOMAINS` and `ALLOWED_RETRIEVE_DOMAINS` are independent browser `Origin` allowlists, with `Referer` as a fallback. Exact hosts and `*.example.com` wildcards work. Unset means any origin; blocked requests get `403`, and allowed origins receive matching CORS headers, including preflight.
- `UPLOAD_SECRET` and `RETRIEVE_SECRET` are independent bearer gates. Each returns `401` for a missing or wrong token; set one, both, or neither. Retrieval still requires the single-use handoff token.
- Requests with neither `Origin` nor `Referer` are allowed because server-to-server clients do not send them. Domain checks are browser controls, not authentication; use the secrets for that. A browser address-bar download cannot send `Authorization`, so `RETRIEVE_SECRET` requires a client that can set headers.
- `MAX_PAYLOAD_BYTES`, `ALLOWED_CONTENT_TYPES`, and `REQUIRE_PDF_MAGIC` apply to uploads only. The size cap is checked from `Content-Length` and enforced again while streaming (`413`); the MIME and PDF-signature filters return `415`.
- `Content-Type` is declared by the client and echoed on retrieve. FHS does not sniff file contents or scan for malware.

### Content sniffing (optional)

`ALLOWED_CONTENT_TYPES` is only as strong as the declared header. Set
`REQUIRE_PDF_MAGIC=true` (normally with `ALLOWED_CONTENT_TYPES=application/pdf`) to require a
declared PDF to start with `%PDF-`. FHS buffers at most five bytes, checks before the first chunk
is stored, and returns `415` if the signature is missing. It does not scan for malware or validate
the rest of the file, and it still echoes the declared type on retrieve.

### Rendering instead of downloading

Retrieved files are sent with `Content-Disposition: attachment`, so an `<iframe>` or `<embed>`
will download rather than display them. To preview, fetch the handoff with whatever headers your
deployment requires, turn the response into a `Blob`, and use `URL.createObjectURL(blob)`; revoke
the URL when the viewer closes. Removing `attachment` from the Worker is possible but weakens the
default download behavior.

## Security model

- **Single use.** The first successful `GET /retrieve/:token` consumes the handoff. Tokens are random UUIDs (122 bits).
- **No durable storage.** Nothing in the code path touches R2, KV, D1, or `state.storage`.
- **No payload logging.** Only token prefixes, byte counts, and statuses are logged.
- **Header hardening.** Every response is `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`; retrieved files are served as `attachment` (see [Rendering instead of downloading](#rendering-instead-of-downloading)).
- **Optional gates.** `UPLOAD_SECRET` gates posting and `RETRIEVE_SECRET` gates retrieval. Either can be set alone or both together. Without a retrieve secret, possession of the handoff URL is the retrieval credential.

## Honest limits

- **Not durable.** A Durable Object can be evicted while idle, and timers do not survive eviction. A payload may disappear before its TTL. Treat `410` as "upload it again"; FHS is a relay, not a queue.
- **Not a guarantee of physical erasure.** FHS drops its references and zeroes chunks that expire unread, but it cannot prove that every copy inside the V8 heap or OS was overwritten. The guarantee is that the service never persists payloads and retains no reference after delivery or expiry.
- **No recipient authentication by default.** Without `RETRIEVE_SECRET`, anyone holding the handoff URL can download once. Deliver it over your own trusted channel, or set the retrieve secret.
- **No built-in rate limiting.** Put Cloudflare WAF/rate limiting in front of `/upload` for public deployments.
- **Domain filters are not a security boundary.** `ALLOWED_CONTENT_TYPES` trusts the declared header (and `REQUIRE_PDF_MAGIC` checks only the first five bytes), while the domain lists only constrain browser CORS; any non-browser client can omit or forge those headers. Use `UPLOAD_SECRET` and `RETRIEVE_SECRET` for authorization.
- **Compliance is yours.** The architecture removes a stored-data surface, but HIPAA, GLBA, and GDPR obligations cover your whole system, agreements included. FHS is not a certification.

## Project layout

```
index.html, assets/, robots.txt, sitemap.xml, llms.txt   static site served by GitHub Pages
src/index.js                                             Worker + Durable Object
scripts/setup.mjs                                        deploy from another repo, no secrets in it
deploy/pdf-only.jsonc                                    complete duplicate profile for a PDF MIME filter
deploy/simplepdf.jsonc                                   current SimplePDF production profile
test/e2e.test.mjs                                        end-to-end suite (wrangler dev)
test/filters.test.mjs                                    MIME, per-side domain/CORS, and payload-cap tests
test/sides.test.mjs                                      both-sides, upload-only, and retrieve-only tests
test/setup.test.mjs                                      offline dry-run and setup-flag checks
wrangler.jsonc                                           bindings, migration, vars
AGENTS.md                                                rules for agents working in this repo
todo.md, history.md                                      backlog and work log
```

The homepage is served by GitHub Pages from `main` at the repository root (`.nojekyll` disables Jekyll). Keep site asset URLs relative so the project path keeps working.

## License

MIT © 2026 Corey Burns
