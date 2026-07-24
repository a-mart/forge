# Shell boundary

Stable MV3 bootstrap code and shell-owned documents belong here. Payload implementation and release selectors do not.

The worker bootstrap is classic rather than a module worker: Chrome listeners register synchronously, selector and every declared payload file are fetched and SHA-256 verified, and only then may `importScripts` execute the local worker payload. Side-panel payload import is likewise gated on full verification. Eval, blob URLs, remote code, and an unverified hash-shaped directory are not valid fallback paths.
