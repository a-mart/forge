# Source fixtures for Pi extension migration scanner

These fixtures are scanned by `scripts/__tests__/pi-extension-migration.test.mjs`.
Do not import them from production runtime code.

- `legacy-supported.ts` — rewritable `@mariozechner/pi-*` roots
- `legacy-unsupported.ts` — unsupported legacy subpath that must fail closed
