# Shell boundary

Stable MV3 bootstrap code and shell-owned documents belong here. Payload implementation and release selectors do not.

The worker bootstrap is classic rather than a module worker: Chrome listeners register synchronously, while the exact worker payload is statically embedded in a deferred factory that Chromium parses with the installed bootstrap. The selector and every declared payload file are fetched and SHA-256 verified, including an explicit match to the embedded worker hash, before the factory may initialize the payload. Delayed `importScripts`, dynamic import, eval, blob URLs, remote code, and unverified hash-shaped fallback directories are not valid worker paths. Side-panel payload import is likewise gated on full verification.
