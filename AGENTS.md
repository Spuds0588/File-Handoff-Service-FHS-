# AGENTS.md — File Handoff Service (FHS)

Instructions for AI coding agents working in this repository. Read this before changing anything.

## What this is

FHS is a single-use, zero-retention file relay: one Cloudflare Worker (`src/index.js`) plus one Durable Object class (`HandoffVault`). Service A uploads a payload, gets a token, and Service B downloads it exactly once. No R2, KV, D1, or Durable Object storage is involved.

The repository is also a GitHub template. `index.html` and `assets/` at the root are the public site, served by GitHub Pages from `main` at `/`. The Worker lives beside them in `src/`.

## Invariants — do not break these

1. **Zero durable storage.** Never add `state.storage`, KV, R2, D1, queues, caches, or any API that persists payload bytes. This is the product, not an implementation detail.
2. **Single use.** The first successful `GET /retrieve/:token` consumes the handoff. Every later request must return `410`.
3. **No payload in logs or responses.** Log token prefixes, byte counts, and statuses only. Never log bodies, filenames, or document contents.
4. **Bounded memory.** Uploads and downloads stream. Chunks are one Durable Object each. Keep chunk size ≤ 16 MB, total payload ≤ 90 MB, and never buffer a whole payload in the gateway isolate.
5. **No secrets in the repo.** `UPLOAD_SECRET` and `RETRIEVE_SECRET` are Wrangler secrets or local env values. Never commit `.dev.vars`, `.env`, or credentials, and never ask a user to paste an API token into chat.
6. **Response hygiene.** All responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Retrieved files are `Content-Disposition: attachment`.
7. **Migrations are append-only.** Do not edit the existing `tag: "v1"` migration. Add a new tag for a new class.
8. **Honest docs.** Do not claim durability, physical RAM zeroing, certification, or compliance that the platform cannot provide. The README's "Honest limits" section is load-bearing.
9. **Filters default open and sides are independent.** `MAX_PAYLOAD_BYTES`, `ALLOWED_CONTENT_TYPES`, `ALLOWED_UPLOAD_DOMAINS`, and `ALLOWED_RETRIEVE_DOMAINS` must work with no configuration. Content-Type and browser Origin/Referer checks are advisory filters; `UPLOAD_SECRET` and `RETRIEVE_SECRET` are the bearer gates.

## Commands

```bash
npm install            # installs wrangler (pinned; requires Node 20.3+)
npm test               # setup dry-run, end-to-end (:8799), filters (:8800), sides (:8801-:8803)
npm run setup          # deploy this local checkout (sets UPLOAD_SECRET outside the repo)
npm run dev            # local server on 127.0.0.1:8787
npx wrangler deploy    # deploy the Worker (needs wrangler login or CLOUDFLARE_API_TOKEN)
npm run tail           # stream production logs
```

`npm test` needs no Cloudflare account. The end-to-end suite starts a server with test vars (2 MB cap, 256 KB chunks, 5 s TTL, upload secret); the filter suite starts a second one with a MIME allowlist, per-side domain allowlists, and a 1 MB cap; the sides suite starts three more for both-sides, upload-only, and retrieve-only configurations. All are killed afterwards. It must pass before you commit.

## Deploying

- **Worker:** `npx wrangler deploy`. Without `wrangler login` or `CLOUDFLARE_API_TOKEN` in the environment it will fail; report that instead of inventing credentials. This repo's owner does not keep Cloudflare credentials in the repo.
- **Homepage:** commit to `main`; GitHub Pages publishes from the repository root (`.nojekyll` disables Jekyll). Keep asset and link URLs relative (`assets/styles.css`, `favicon.svg`) because the site lives under `/File-Handoff-Service-FHS-/`. Absolute URLs appear only in canonical, Open Graph, sitemap, and structured-data tags.

## Setup script

`scripts/setup.mjs` deploys FHS for callers who are working in another repository and should not
add this code or any secret to it.

- Secrets must never enter a repo. `UPLOAD_SECRET` comes from the environment or from
  `~/.fhs/upload-secret` (mode 600); `RETRIEVE_SECRET` is not managed by the script and must be set
  with `wrangler secret put`; `CLOUDFLARE_API_TOKEN` stays in the environment. Never print a
  secret value.
- The script checks out to `os.tmpdir()` and removes the checkout unless `--keep` is passed.
- `--dry-run --repo .` must stay offline and side-effect free. `test/setup.test.mjs` guards it.
- Do not make the script write into the current working directory.

## Dev environment hygiene — required after every task

This machine is memory-constrained. Before you report a task complete:

```bash
# 1. Stop every server you started, by recorded PID (never pkill -f patterns)
kill <pid>
lsof -i:8787 -i:8799 -i:8800 -i:8801 -i:8802 -i:8803 2>/dev/null   # must print nothing

# 2. Remove transient state and dependencies
rm -rf node_modules .wrangler

# 3. Remove temp artifacts you created
rm -f /tmp/fhs-* fhs-test-* *.bin

# 4. Leave the tree clean
git status --short                   # only intended changes
```

- Run one `wrangler dev` instance at a time, on a port you recorded.
- Do not leave background processes running between tasks. If you started one with a background runner, stop it explicitly.
- `npm install` recreates `node_modules` when the suite is needed again; do not commit it.
- Large test payloads are generated in memory; do not write multi-megabyte fixtures to disk.

## Work tracking

- `todo.md` is the backlog and the current checklist. Update it when you finish or add work.
- `history.md` is append-only. Add a dated entry for each task: what changed, decisions, verification output (including counts), and deploy status.
- Commit messages should say why the change was made.

## Testing guidance

Add checks to `test/e2e.test.mjs` when behavior changes. Keep the suite self-contained: spawn `wrangler dev`, wait for HTTP readiness (never rely on a banner), assert with `node:assert/strict`, and always tear the server down. Cover the happy path, single-use semantics, expiry, size cap, and method/route errors.

`test/filters.test.mjs` covers shared-fallback behavior: MIME allowlists (blocked uploads return `415`), browser-origin allowlists with CORS and preflight (blocked origins return `403`), and the payload cap (`413`). `test/sides.test.mjs` covers both-sides, upload-only, and retrieve-only configurations, including `RETRIEVE_SECRET` and per-side preflight. `test/e2e.test.mjs` must keep proving the defaults are open: no MIME or domain configuration, wildcard CORS, no retrieve secret, and uploads without `Origin`.

## Site guidance

The homepage is indexed by search engines and parsed by answer engines. If you edit it:

- Keep one `<h1>`; keep headings semantic and question-shaped in the FAQ.
- Keep the visible FAQ and the `FAQPage` JSON-LD in sync.
- Keep `meta description`, canonical, `sitemap.xml`, `robots.txt`, and `llms.txt` accurate when limits change.
- No third-party assets, fonts, analytics, or cookies. The footer states this; keep it true.
