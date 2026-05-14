# Forge Skill Share Worker

Temporary, anonymous, R2-backed transfer service for one Forge skill bundle at a time. This is not a marketplace or registry: there is no account system, search, listing endpoint, publisher profile, install tracking, or remote update channel.

## Abuse and cost controls

The Worker is designed so a public anonymous upload endpoint cannot create unbounded storage or egress exposure:

- **Hard request/body caps:** `MAX_REQUEST_BYTES` is capped by code at 35 MiB even if configured higher.
- **Hard bundle caps:** raw bundle file totals are capped by code at 25 MiB, files at 2 MiB each, and file count at 512, even if configured higher.
- **Validation before storage:** uploads are fully parsed and validated before any R2 write. The Worker checks bundle format, path safety, duplicate/case-insensitive path collisions, file hashes, total sizes, `contentSha256`, `SKILL.md` presence, and derived skill/portability metadata.
- **Durable anonymous upload enforcement:** a required Durable Object (`SHARE_LIMITER`) enforces per-IP upload limits before `bucket.put()`. The Worker fails closed with 503 if the binding is absent.
- **Aggregate storage budgets:** the same Durable Object reserves active object count and active storage bytes before R2 writes. Defaults are 1,000 active objects and 5 GiB, with code-level hard caps even if env vars are raised.
- **Bounded download/egress:** after a token is verified but before any R2 read, the Durable Object authorizes and increments per-share download count and byte-egress budgets using stored share byte metadata. Defaults are 20 downloads or 250 MiB per share.
- **Cloudflare edge rate limits:** configure Cloudflare WAF/rate-limiting rules on `POST /api/v1/skill-shares` as defense in depth. Worker-side Durable Object enforcement remains mandatory and fail-closed.
- **No open listing:** there is no API route that lists shares or object metadata.
- **Bearer tokens only:** object keys are random IDs signed with HMAC and are not derived from skill handles.
- **TTL enforced on reads:** links expire at read time even if R2 physical deletion lags.
- **Scheduled deletion:** cron deletes expired objects under `skill-shares/` hourly.
- **R2 lifecycle backstop:** configure an R2 lifecycle rule to expire/delete `skill-shares/` objects after 8 days.
- **Least privilege:** local Forge never receives Cloudflare credentials. The Worker only needs the R2 binding plus `TOKEN_HMAC_SECRET`.
- **No sensitive logs:** the Worker does not log bundle content or full bearer URLs/tokens.
- **Security headers:** landing and API responses set no-store caching, CSP, `nosniff`, no referrer, and frame-denial headers. CORS is intentionally `*` only for unauthenticated JSON bundle download/upload endpoints because the bearer link is the capability and responses remain no-store.

## Required deployment config

R2 binding:

- `SKILL_SHARES_BUCKET`: R2 bucket binding for temporary bundle objects.

Durable Object binding:

- `SHARE_LIMITER`: required Durable Object namespace for global upload/storage/download quota enforcement. If absent, the Worker refuses upload/download operations.

Secret:

- `TOKEN_HMAC_SECRET`: HMAC secret, at least 32 characters. Set with `wrangler secret put TOKEN_HMAC_SECRET`.

Recommended vars:

- `PUBLIC_BASE_URL`: public origin such as `https://share.forge.dev`.
- `SHARE_TTL_SECONDS`: defaults/hard-caps to `604800` (7 days).
- `MAX_REQUEST_BYTES`: default/hard-cap `36700160` (35 MiB).
- `MAX_BUNDLE_BYTES`: default/hard-cap `26214400` (25 MiB).
- `MAX_FILE_BYTES`: default/hard-cap `2097152` (2 MiB).
- `MAX_FILES`: default/hard-cap `512`.
- `UPLOAD_RATE_LIMIT_PER_MINUTE`: default `10`.
- `DOWNLOAD_RATE_LIMIT_PER_MINUTE`: default `120`.
- `MAX_ACTIVE_OBJECTS`: default `1000`, hard-cap `10000`.
- `MAX_ACTIVE_STORAGE_BYTES`: default `5368709120` (5 GiB), hard-cap 50 GiB.
- `MAX_DOWNLOADS_PER_SHARE`: default `20`, hard-cap `100`.
- `MAX_EGRESS_BYTES_PER_SHARE`: default `262144000` (250 MiB), hard-cap 1 GiB.

Values above hard caps are clamped down by code. Use lower values for emergency cost-control.

## Required Cloudflare account setup

The Worker enforces hard caps itself, but the operated service should also configure Cloudflare account-level controls:

```bash
# Create the temporary bucket.
wrangler r2 bucket create forge-skill-shares

# Configure a strong HMAC secret.
openssl rand -base64 48 | wrangler secret put TOKEN_HMAC_SECRET

# Deploy with the Durable Object migration in wrangler.toml.
wrangler deploy
```

Add an R2 lifecycle rule in the Cloudflare dashboard or IaC for prefix `skill-shares/`:

- Action: delete objects
- Prefix: `skill-shares/`
- Age: 8 days

Add a Cloudflare WAF/rate-limit rule for defense in depth:

- Match: `http.request.method eq "POST" and http.request.uri.path eq "/api/v1/skill-shares"`
- Action: block or challenge after a low threshold such as 30 requests per IP per minute
- Separate emergency rule: block all `POST /api/v1/skill-shares` if abuse/cost alarms fire

Recommended cost alarms:

- Alert on R2 bucket size above the expected active budget.
- Alert on request/egress spikes for the share hostname.
- Lower `MAX_ACTIVE_*`, `MAX_DOWNLOADS_PER_SHARE`, or `MAX_EGRESS_BYTES_PER_SHARE` immediately during an incident; the Worker clamps env values and fails closed if quota state is unavailable.

## API

- `POST /api/v1/skill-shares`: accepts a bundle JSON object or `{ "bundle": ... }`, validates it, stores it in R2, and returns `shareUrl`, `importUrl`, `expiresAt`, `contentSha256`, and `warnings`. `warnings` is a `SkillBundleIssue[]` projected from warning-bearing bundle metadata, currently including frontmatter warnings.
- `GET /s/<token>`: landing page by default; returns bundle JSON for `Accept: application/json` or `?download=1`.
- `GET /api/v1/skill-shares/<token>`: JSON-only download endpoint for local Forge preview/import.

All API responses use `Cache-Control: no-store`.

## Validator parity strategy

The Worker intentionally validates bundles before storage so cloud costs cannot be created by malformed input. To prevent backend/Worker validator drift, `apps/backend/src/swarm/__tests__/skill-bundle-validator-parity.test.ts` runs a shared representative corpus through both validators. The corpus covers valid bundles plus known drift/security cases including non-canonical text encoding, spoofed derived metadata, case-insensitive path collisions, Windows-unsafe paths, and sensitive file paths.

## Local validation

```bash
pnpm --filter @forge/skill-share-worker test
pnpm --filter @forge/skill-share-worker build
cd apps/backend && pnpm exec vitest run src/swarm/__tests__/skill-bundle-validator-parity.test.ts
```
