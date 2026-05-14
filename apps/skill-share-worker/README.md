# Forge Skill Share Worker

Temporary, anonymous, R2-backed transfer service for one Forge skill bundle at a time. This is not a marketplace or registry: there is no account system, search, listing endpoint, publisher profile, install tracking, or remote update channel.

## Abuse and cost controls

The Worker is designed so a public anonymous upload endpoint cannot create unbounded storage or egress exposure:

- **Hard request/body caps:** `MAX_REQUEST_BYTES` is capped by code at 35 MiB even if configured higher.
- **Hard bundle caps:** raw bundle file totals are capped by code at 25 MiB, files at 2 MiB each, and file count at 512, even if configured higher.
- **Validation before storage:** uploads are fully parsed and validated before any R2 write. The Worker checks bundle format, path safety, duplicate/case-insensitive path collisions, file hashes, total sizes, `contentSha256`, `SKILL.md` presence, and derived skill/portability metadata.
- **Anonymous upload rate limiting:** in-Worker per-IP soft throttle defaults to 10 uploads/minute. Configure Cloudflare WAF/rate-limiting rules on `POST /api/v1/skill-shares` as the authoritative edge control.
- **Download rate limiting:** in-Worker per-IP soft throttle defaults to 120 downloads/minute. Objects are capped and short-lived to keep egress bounded.
- **No open listing:** there is no API route that lists shares or object metadata.
- **Bearer tokens only:** object keys are random IDs signed with HMAC and are not derived from skill handles.
- **TTL enforced on reads:** links expire at read time even if R2 physical deletion lags.
- **Scheduled deletion:** cron deletes expired objects under `skill-shares/` hourly.
- **R2 lifecycle backstop:** configure an R2 lifecycle rule to expire/delete `skill-shares/` objects after 8 days.
- **Least privilege:** local Forge never receives Cloudflare credentials. The Worker only needs the R2 binding plus `TOKEN_HMAC_SECRET`.
- **No sensitive logs:** the Worker does not log bundle content or full bearer URLs/tokens.

## Required deployment config

R2 binding:

- `SKILL_SHARES_BUCKET`: R2 bucket binding for temporary bundle objects.

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

Values above hard caps are clamped down by code. Use lower values for emergency cost-control.

## API

- `POST /api/v1/skill-shares`: accepts a bundle JSON object or `{ "bundle": ... }`, validates it, stores it in R2, and returns `shareUrl`, `importUrl`, `expiresAt`, and `contentSha256`.
- `GET /s/<token>`: landing page by default; returns bundle JSON for `Accept: application/json` or `?download=1`.
- `GET /api/v1/skill-shares/<token>`: JSON-only download endpoint for local Forge preview/import.

All API responses use `Cache-Control: no-store`.

## Local validation

```bash
pnpm --filter @forge/skill-share-worker test
pnpm --filter @forge/skill-share-worker build
```
