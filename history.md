# History

Append-only work log. Newest entry last.

## 2026-11-03 — v1 build, local verification, first publish

**Built.** First working version of the service, from the PRD in
`chat-ephemeral-file-handoff-service-google-ai-studio-2026-11-03-1226.md`.

- `src/index.js`: Worker routes (`GET /`, `POST /upload`, `GET /retrieve/:token`) and the
  `HandoffVault` Durable Object. Payloads are split into chunks; each chunk lives in its own
  Durable Object; the layout record is written last so the TTL clock starts at seal time.
- `wrangler.jsonc`: `HANDOFF_VAULT` binding, `v1` migration using `new_sqlite_classes` (required
  for new namespaces on the Workers free plan), no storage APIs in the class.
- `test/e2e.test.mjs`: self-contained suite that boots `wrangler dev` on `127.0.0.1:8799` with a
  2 MB cap, 256 KB chunks, 5 s TTL, and an upload secret.
- `index.html`, `assets/styles.css`, `favicon.svg`: static homepage for GitHub Pages.
- `robots.txt`, `sitemap.xml`, `llms.txt`: crawl and answer-engine surface.
- `README.md`, `AGENTS.md`, `todo.md`, `history.md`.

**Decisions and deviations from the source PRD.**

- Default payload is 25 MB / 8 MB chunks instead of the PRD's 120 MB / 15 MB. The Workers free
  and pro request-body ceiling is 100 MB, and the isolate memory limit is 128 MB, so 120 MB was
  not deployable as written. The cap is configurable up to 90 MB.
- Chunks are not zero-filled at delivery, because a buffer cannot be zeroed while it is being
  sent. The vault hands ownership to the outbound response and drops its reference; chunks that
  expire unread are zero-filled. This limitation is documented instead of overstated.
- `wrangler` is pinned to `4.80.0`, the newest release that still supports Node 20.3 (later 4.x
  releases require Node 22, and this machine runs Node 20.19).
- Uploads can be gated with `UPLOAD_SECRET`; the source PRD left open ingress unaddressed.
- No Open Graph image: no image tooling available, and adding a binary for a summary card was
  not worth the repo weight in v1.

**Verification (local).** `npm test` → 10/10 checks passed, exit 0. Covered: descriptor and live
limits, 401 without the upload secret, 700 KB multi-chunk round trip with matching SHA-256,
single-use 410 on the second GET, zero-byte payloads, malformed token 400, unknown token 410,
oversize 413, 405/404 handling, and TTL expiry after an unretrieved handoff.

Site checks: JSON-LD parses (SoftwareApplication, WebSite, HowTo, FAQPage), every internal
anchor resolves, all local assets exist and are referenced relatively, `robots.txt` points at
`sitemap.xml`. No Cloudflare account was needed for any of this.

**Publish.** Static homepage published to GitHub Pages from `main` (source: branch `main`,
path `/`, `.nojekyll`). The Worker is not deployed: no Cloudflare account or credentials were
available in this environment. Commit `9e24b9b`, Pages build status `built` for that commit.

**Production verification.** `https://spuds0588.github.io/File-Handoff-Service-FHS-/` returns
200 `text/html`; `assets/styles.css` returns 200 `text/css`; `favicon.svg`, `robots.txt`,
`sitemap.xml`, and `llms.txt` all return 200 with the expected content types. The live page has
the intended title, description, and canonical; the JSON-LD block parses in the browser with
SoftwareApplication, WebSite, HowTo, and FAQPage (7 questions); the stylesheet applies; no
console errors, no failed requests, no horizontal overflow. The copy button on the agent prompt
switches to “Copied”. The Worker itself has no public deployment yet, so its API was verified
only against local `wrangler dev`.

## 2026-11-03 — Docs fix: one language in the API examples

The homepage mixed a Node.js producer with a Python consumer, which made one handoff look like
two different integrations. Both snippets are now Node.js, matching the Worker, the repo, and
Node 20's global `fetch`. A short note says any HTTP client works, so non-Node consumers are not
left guessing; no tabbed multi-language widget was added because it would grow the page's script
for a case the API does not require. `npm test` is unaffected (HTML and markdown only).

## 2026-11-03 — Author attribution on the site and in structured data

Added a `Person` node to the JSON-LD graph for Corey Burns with `url` and `sameAs` pointing at
https://github.com/Spuds0588 and https://www.linkedin.com/in/coreytburns. `SoftwareApplication`
and `HowTo` now reference it by `@id`, and `WebSite` names it as publisher, so the author is one
entity rather than three unlinked strings. Added a footer line linking both profiles with
`rel="me"`, and the same attribution to `llms.txt`. The LinkedIn URL was not on the GitHub
profile (only a Linktree); it was read from the public Linktree that the GitHub account links to
rather than guessed.

## 2026-11-03 — One-click Deploy to Cloudflare

Added the official Deploy to Cloudflare button
(`https://deploy.workers.cloudflare.com/?url=…`) to the top of the README and as a primary
button in the homepage deploy section. The button clones the repo into the deployer's GitHub
account, provisions the `HANDOFF_VAULT` Durable Object from `wrangler.jsonc`, and builds with the
`deploy` script already in `package.json`, so no binding setup is required.

`.dev.vars.example` documents `UPLOAD_SECRET` but keeps the line commented. Cloudflare's deploy
button treats every uncommented entry as a required secret pre-filled with the value in the file
(cloudflare/workers-sdk#14639), so a committed placeholder would ship as the real secret. A
commented line means no prompt and no fake protection, and the README and homepage tell deployers
to set the key immediately with `wrangler secret put UPLOAD_SECRET`. If it is skipped, uploads are
open until the TTL drops the bytes.

This is as close to one click as the platform allows: one GitHub authorization, no required
fields, then a live `workers.dev` URL. A secure-by-default flow would need the platform to
generate or require a secret at deploy time, which it does not do for this template.

## 2026-11-03 — Setup script for deploying from another repository

Added `scripts/setup.mjs` so an agent working in a different repository can deploy FHS without
cloning it into that repository. The script checks the repo out under `os.tmpdir()`, installs,
deploys, sets `UPLOAD_SECRET`, verifies a real upload/retrieve/410 against the live URL, and
removes the checkout.

Secrets stay outside the caller's repo: `UPLOAD_SECRET` is read from the environment or reused
or generated at `~/.fhs/upload-secret` (dir 700, file 600), and the value is never printed.
`CLOUDFLARE_API_TOKEN`, if present, stays in the environment. `--dry-run` is offline and
side-effect free; `--keep` preserves the checkout and `--ref` selects a branch or tag.

Added `test/setup.test.mjs` for the dry-run path and changed `npm test` to run it before the
existing end-to-end suite. Updated the README, homepage (deploy section and agent prompt),
`llms.txt`, and `AGENTS.md`.

## 2026-11-03 — Deploy options surfaced

The setup script existed but read as a footnote at the bottom of the deploy section. The README
deploy section now opens with the three supported paths (one click, setup script, CLI) and
keeps the setup script as its own subsection; the CLI instructions were consolidated there
instead of living below the quick start. The homepage shows two buttons at the top of the
deploy section and places the setup-script commands before the CLI steps, with an anchor for
the second button.

## 2026-11-03 — Open-by-default filters: size, MIME types, browser origins

Added two new optional filters and documented the existing size cap as the third. Every filter
is wildcard when unset, so existing deployments keep the same behavior.

- `MAX_PAYLOAD_BYTES` already existed; it is now presented as the maximum-file-size filter and
  remains the only one enforced while streaming.
- `ALLOWED_CONTENT_TYPES` accepts a comma-separated MIME allowlist with exact values and
  `type/*` wildcards. A blocked upload returns `415` before the body is stored. Content-Type is
  declared by the client, so this is a filter, not content inspection.
- `ALLOWED_DOMAINS` accepts exact hostnames and `*.example.com` wildcards. It checks browser
  `Origin` first and falls back to `Referer`; a present but disallowed source returns `403`.
  Requests with neither header are allowed, because server-to-server clients do not send them.
  This is deliberately a browser control, not authentication; `UPLOAD_SECRET` remains the gate.
- CORS is now handled explicitly. With no domain allowlist, responses carry
  `Access-Control-Allow-Origin: *` and `OPTIONS` preflight succeeds. With an allowlist, allowed
  origins are echoed with `Vary: Origin`, including on errors and retrieve responses; preflight
  from a disallowed origin returns `403`.
- The root descriptor now includes a `filters` object (`"any"` when open).

**Verification (local).** `npm test` → exit 0: setup dry-run ok, end-to-end 11/11, filters
11/11. New coverage includes default wildcard CORS, MIME rejection, exact and wildcard MIME
acceptance, allowed/disallowed origins, the `Referer` fallback, wildcard subdomains not matching
the apex, no-Origin server-to-server requests, preflight, retrieve CORS, CORS on a `415`, and the
1 MB test cap.

**Deploy status.** Worker not deployed: no Cloudflare account or credentials are available in
this environment. Homepage and docs changes are committed to `main` for GitHub Pages; the live
Worker behavior remains verified only against local `wrangler dev`.
