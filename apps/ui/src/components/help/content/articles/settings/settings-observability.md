Use **Settings > Observability** to export Forge runtime traces to a local Arize Phoenix instance. This is a Builder-only V1 feature. Collaboration mode does not export traces and fails closed/no-op for the Phoenix settings routes.

## Status and test export

The top of the pane shows whether Phoenix export is enabled, configured, and active. Use **Refresh status** to update counters and last-export state. Use **Test export** to send a small test span with the current unsaved form values, which is the fastest way to confirm Phoenix is running and reachable.

## Endpoint

Forge exports OTLP HTTP/protobuf traces to Phoenix. The default endpoint is:

```text
http://127.0.0.1:6006/v1/traces
```

V1 only allows loopback HTTP endpoints: `localhost`, `127.0.0.0/8`, or `::1`, and the path must end in `/v1/traces`. Credentials, query strings, and fragments are rejected.

## Capture controls

Rich mode can include runtime, prompt, LLM, tool, delivery, lifecycle, error, and feedback spans. The capture toggles let you turn prompt bodies, model inputs and outputs, tool inputs and results, feedback comments, and image data on or off. Metadata-only mode keeps spans useful for flow and timing analysis without prompt/model body capture.

## Privacy, redaction, and caps

Redaction is on by default. Forge can hash identifiers, reduce paths to basename plus hash, suppress display names, and apply extra redaction patterns. Content and attribute caps limit how much text can be attached to a span, and truncation/redaction counters appear in status.

Phoenix observability is local-first and fail-open: export failures should not block normal Forge work. Treat captured traces as potentially sensitive because rich mode can include prompts, model outputs, tool payloads, and feedback text.

## Validation caveat

This feature still needs user-owned live Phoenix/golden-trace validation and Electron package/preflight validation before relying on it as a release gate.
