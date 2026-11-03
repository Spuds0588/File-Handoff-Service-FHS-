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

## 2026-11-03 — Independent filters for upload and retrieve

Split browser-domain filtering into two independent sides and added an optional retrieval
secret. The shared `ALLOWED_DOMAINS` remains as a fallback, so existing single-list configurations
keep working, but either side can now be opened or closed on its own.

- `ALLOWED_UPLOAD_DOMAINS` and `ALLOWED_RETRIEVE_DOMAINS` override the shared list per side. An
  unset side inherits `ALLOWED_DOMAINS`; setting a side-specific value to empty opens that side.
  Route-specific CORS and preflight mean an origin allowed for upload is not automatically
  allowed for retrieval, or vice versa.
- `RETRIEVE_SECRET` adds an optional constant-time bearer gate to `GET /retrieve/:token`. It is
  independent of `UPLOAD_SECRET`: either, both, or neither may be set. The single-use token is
  still required, and a missing or wrong secret returns `401` with `WWW-Authenticate: Bearer`.
- The descriptor's `filters` object now reports `uploadDomains` and `retrieveDomains` separately;
  `auth` reports whether each secret is required. Secret values are never exposed.
- `MAX_PAYLOAD_BYTES` and `ALLOWED_CONTENT_TYPES` remain upload-only. Domain checks remain browser
  CORS controls; a no-`Origin`/`Referer` request is allowed, so the secrets are the real gates.

**Verification (local).** `npm test` → exit 0: setup dry-run ok, end-to-end 11/11, shared filter
11/11, side-specific 12/12 (34 runtime checks). The side suite starts three servers on
`127.0.0.1:8801-8803` and covers both sides filtered, only upload filtered, only retrieve
filtered, `RETRIEVE_SECRET` missing/wrong/correct, per-side retrieve CORS, no-Origin retrieval,
and per-side preflight.

**Deploy status.** Worker not deployed: no Cloudflare account or credentials are available in
this environment. Documentation and the homepage are committed to `main` for GitHub Pages; the
Worker behavior remains verified only against local `wrangler dev`.

## 2026-11-03 — Remove the pre-deploy shared-domain fallback

Nothing has been deployed yet, so `ALLOWED_DOMAINS` was deleted instead of being maintained as a
compatibility layer. `ALLOWED_UPLOAD_DOMAINS` and `ALLOWED_RETRIEVE_DOMAINS` are now the only
domain filters; each is independently optional, and unset means open on that side. The fallback
and override rules are gone from the Worker, descriptor, tests, configuration examples, and docs.

**Verification.** `npm test` → exit 0: setup dry-run ok, end-to-end 11/11, filters 11/11, sides
12/12 (34 runtime checks). The filter suite now sets both side-specific lists; the sides suite
still covers both-sides, upload-only, and retrieve-only behavior.

**Deploy status.** Worker not deployed; no Cloudflare credentials are available. Homepage and
docs are committed to `main` for GitHub Pages.

## 2026-11-03 — Docs consistency after removing the fallback

Cleaned up the last stale references in current docs and test comments. The README now describes
only `ALLOWED_UPLOAD_DOMAINS` and `ALLOWED_RETRIEVE_DOMAINS`; its summary no longer implies that
size and MIME filters apply to retrieval. The `llms.txt` summary says the same. `AGENTS.md` and
the suite comments no longer call the filter suite “shared-fallback,” and the README project
layout describes the per-side domain tests correctly. Historical entries above still describe the
fallback while it existed; this entry supersedes them for the current configuration.

**Verification.** Documentation-only change: JSON-LD parses, the visible FAQ matches the eight
JSON-LD questions, no `ALLOWED_DOMAINS` references remain in current docs/config/test code, and
`git diff --check` is clean. No runtime code changed; the previous 34 runtime checks remain valid.

**Deploy status.** Worker not deployed. Documentation changes pushed to `main` for GitHub Pages.

## 2026-11-03 — First-deployment feedback: setup and docs hardening

Acted on a fresh-account deployment report. The main defect was not the Worker: the documented
first step could fail before the Worker was involved, and the setup script could not express the
filtered or open-upload configurations people actually deploy.

- `scripts/setup.mjs` now detects Cloudflare error `10063` and prints the dashboard or API-token
  path. `--subdomain <name>` can check or create the subdomain through the Cloudflare API when
  `CLOUDFLARE_API_TOKEN` is available; OAuth-only users are directed to Workers & Pages.
- Added `--config <file>` (validated inside the checkout) and `--no-upload-secret`. The latter
  leaves a fresh Worker open but deliberately does not delete an existing secret. `RETRIEVE_SECRET`
  from the environment is used only for the live verification request.
- Verification now reads `GET /`, picks a probe matching `filters.allowedContentTypes`, and treats
  a filtered `415` or an unprovided retrieve secret as “deployed; verification skipped” rather than
  a failed deploy. Descriptor retries cover the new-subdomain TLS lag.
- Added a complete `deploy/pdf-only.jsonc` profile. Wrangler 4.80 rejects `extends`, so the profile
  repeats `main`, the Durable Object binding, and the migration; it was bundled with
  `wrangler deploy --dry-run --config`.
- Docs now cover the `10063` prerequisite, TLS lag, `--repo`/`--config`/`--no-upload-secret`/
  `--subdomain`, custom profiles, per-suite test scripts and port overrides, which consumer each
  filter constrains, `Content-Disposition: attachment` and the Blob workaround, declared versus
  sniffed MIME types with a `%PDF-` recipe, internal `409`, and post-header stream failures.
- `AGENTS.md` now scopes cleanup to the end of a task, not the end of each deploy, and documents
  the setup flags and first-deploy failure mode.

**Verification.** `npm test` → exit 0: setup dry-runs 7/7, end-to-end 11/11, filters 11/11, sides
12/12 (41 checks). The PDF profile bundles successfully with the pinned Wrangler. JSON-LD parses
with nine FAQ questions and the visible FAQ matches it. `git diff --check` is clean.

**Deploy status.** No Worker was deployed. The `--subdomain` path was not exercised against
Cloudflare because it would create account state and needs a REST API token; its dry-run and
validation paths are covered locally.

## 2026-11-03 — Reconcile source with production, deploy, and verify

Production inspection showed the live Worker was ahead of the repository: it reported
`filters.requirePdfMagic: true`, a 300-second TTL, `ALLOWED_CONTENT_TYPES=application/pdf`, and a
`simplepdf.com` retrieve allowlist. The source had no PDF-signature capability and no committed
profile for those settings, so the deployment was not reproducible from `main`.

- Added `REQUIRE_PDF_MAGIC` (`true`/`1`/`yes`) to the Worker. For uploads declared
  `application/pdf`, it buffers at most five bytes, checks for `%PDF-` before the first chunk is
  stored, and returns `415` with the production message otherwise. The descriptor now reports
  `filters.requirePdfMagic`; the default remains false.
- Added `deploy/simplepdf.jsonc` with the exact production bindings and `deploy/pdf-only.jsonc`
  with the generic PDF profile. Both keep the existing Durable Object binding and `v1` migration.
- Updated the filter suite to prove the magic check rejects a fake PDF and leaves non-PDF MIME
  filtering independent; the end-to-end suite proves the default is off.
- Updated README, homepage, `llms.txt`, `AGENTS.md`, and TODO for the new setting and profiles.

**Verification.** `npm test` → exit 0: setup dry-runs 7/7, end-to-end 11/11, filters 12/12, sides
12/12 (42 checks). Both deploy profiles bundle with the pinned Wrangler. Deployed `main` at
commit `f0f1a40` to production with `deploy/simplepdf.jsonc`; current Version ID
`3c1fb49b-cf5b-4d95-adc1-030c0252d62c`.

Production checks against `https://file-handoff-service.spuds0588.workers.dev`: descriptor
reported the expected 300-second TTL, PDF-only MIME and signature rules, no upload/retrieve
secret, and the SimplePDF origin list. A non-PDF body declared as PDF returned `415`; a valid
`%PDF-` upload returned `201` with `expiresInSeconds: 300`; an unapproved retrieve origin returned
`403`; the SimplePDF origin retrieved identical bytes with `Content-Disposition: attachment`; the
second retrieve returned `410`.

**Remaining gap.** `--subdomain` creation itself was still not exercised against Cloudflare because
it needs a REST API token and would create account state; its dry-run/validation paths and the
existing live subdomain are verified.

## 2026-11-03 — Shutdown instructions

Documented how to take FHS down after it is deployed. Deleting the Worker is the stop signal:
`npx wrangler delete` for the default config, or `npx wrangler delete --config <profile>` for a
custom profile. The instructions also cover the dashboard path, a leftover Durable Object
namespace, Worker-scoped secrets, the separate account-wide `workers.dev` subdomain, and removing
the local `~/.fhs/upload-secret` generated by the setup script.

The teardown guidance now appears in the README, the homepage navigation/section/FAQ, `llms.txt`,
`AGENTS.md`, `wrangler.jsonc`, the TODO checklist, and the setup script's completion output.

**Verification.** Docs-only change apart from the setup summary line: JSON-LD parses with ten FAQ
questions, the visible FAQ matches it, and `git diff --check` is clean. The existing 42 runtime
checks still apply; no Worker code changed and production was not redeployed.
