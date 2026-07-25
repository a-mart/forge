# Test boundary

This suite covers fragmented/coalesced/malformed/oversized native frames, exact Chrome launch-origin and stdout isolation, stale rendezvous handling, the transcript-bound challenge handshake, per-connection key derivation, nonce/sequence/cross-connection replay defense, protocol skew, and relay lifecycle cleanup.

`transport.test.ts` drives authenticated records from a fast producer into a deliberately stalled consumer. It verifies exact message and aggregate decoded-byte high-water thresholds, deterministic overflow close, normal queue drain accounting, pending read/write settlement, and zero retained queue counters after close.

Real secrets, production rendezvous/registration, Desktop or browser processes, profile data, and OS mutation are never used.
