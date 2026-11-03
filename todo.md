# TODO

## v1 — shipped 2026-11-03

- [x] Worker: `POST /upload`, `GET /retrieve/:token`, `GET /` descriptor
- [x] Durable Object `HandoffVault`: in-memory chunks, seal-time TTL, single-use burn, zero-fill on expiry
- [x] Chunked streaming both directions (8 MB default chunks, 25 MB default cap)
- [x] Optional `UPLOAD_SECRET` and `RETRIEVE_SECRET` bearer gates, independently settable
- [x] Config vars: `TTL_SECONDS`, `MAX_PAYLOAD_BYTES`, `CHUNK_SIZE_BYTES`, `ALLOWED_CONTENT_TYPES`, `ALLOWED_UPLOAD_DOMAINS`, `ALLOWED_RETRIEVE_DOMAINS`
- [x] Independent, open-by-default filters on both sides: payload cap, MIME-type allowlist, browser-origin allowlists with CORS and preflight, and optional bearer gates
- [x] End-to-end, filter, and side-specific suites booting `wrangler dev` locally (`npm test`)
- [x] Zero-prompt `wrangler.jsonc` with `HANDOFF_VAULT` binding and `v1` migration
- [x] SEO/AEO homepage on GitHub Pages: structured data, FAQ, sitemap, robots, `llms.txt`
- [x] Copyable AI agent prompt on the homepage
- [x] `AGENTS.md`, `todo.md`, `history.md`
- [x] One-click Deploy to Cloudflare button in the README and on the homepage, with documented post-deploy secret steps
- [x] `scripts/setup.mjs` for agents working in another repo: temporary checkout, secret stored outside the repo, live verification

## Next

- [ ] Deploy the Worker to a real Cloudflare account and run the suite against production
- [ ] Add a custom domain and update canonical/sitemap URLs if the site moves
- [ ] Rate limiting or WAF rules for `/upload` on public deployments
- [ ] `DELETE /retrieve/:token` to burn a handoff without downloading it
- [ ] CI: run `npm test` on pull requests, plus an HTML/JSON-LD validation job
- [ ] Optional `X-FHS-Filename` so downloads keep their original name
- [ ] Add an Open Graph image once there is a design for one
- [ ] Optional `--vendor <dir>` mode to copy the Worker and config into an existing repo for customization
