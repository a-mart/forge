Response throughput shows how quickly eligible model calls return provider-final output across the **complete request**. It is a performance signal for one model call, not the whole agent run: time between separate model calls and unrelated agent tools is not included.

**Show response throughput in conversations** in **Settings → General** is off by default. Turn it on to show conversation controls; turning it off hides only those controls, while **Stats → Throughput** continues collecting and showing history.

## Availability

Response throughput is currently recorded only for manager and worker model calls that run through the **Pi runtime**. A provider appearing in a model selector does not make every runtime eligible; other runtime paths do not add response-throughput records.

## Header and worker indicators

When conversation response throughput is enabled, an eligible local manager header keeps one fixed control visible. While a generation is active it uses a restrained activity pulse and holds the latest exact completed call value dimmed, or shows `— tok/s` until an exact result exists. It never estimates a live rate from streamed text.

At completion, the exact final rate is provider-final output tokens divided by the complete monotonic duration from request start to terminal completion. Open the control to see the latest response rate, full request duration, TTFT, output tokens, and model/provider. Hidden reasoning, buffered tool calls, and batched output deltas remain part of the full request duration; they do not shorten the rate. Missing final usage, a missing or zero request duration, or an interrupted generation does not show `0 tok/s` or promote a prior value as the current call.

When conversation response throughput is enabled, active worker pills and Quick Look reserve a throughput cell from the start. They show the final provider value or `—`; they do not show an approximate live rate.

## Throughput statistics

Open **Stats → Throughput** for historical manager/worker totals, role comparison, daily model trends, model summaries, and recent calls. The view is local to Builder even while a Remote Project is selected. Filter by range (including a custom range), project, role, provider/model, attribution, or specialist.

- **All measured responses** (the default) includes terminal calls with provider-final output and a positive complete request duration.
- **Observed-output diagnostics** additionally requires an observed output-through-stream-end boundary. This is a diagnostic filter, not a different response-throughput denominator.
- **All calls** also exposes unmeasured or incomplete lifecycle records for coverage, but does not assign them a rate.

The historical top-line rate is token weighted: provider-final output tokens divided by the sum of complete request-start-to-terminal durations. p50 and p90 use each call's response-throughput rate. Reasoning-token metadata, when a provider reports it, is recorded separately and does not change `tok/s`. Request start, TTFT, first/last output, output span, and the former first-output-to-terminal generation-tail duration remain diagnostics only. An agent-level Pi retry is a separate call; provider-internal retries and Codex WebSocket replays are not timed as separate rates.

Existing JSONL history is never rewritten. Forge re-derives response throughput from stored provider-final output and stored request duration; records without a valid request duration remain unmeasured. Old cached first-output-based values are invalidated after this update.

## History and forks

Terminal measurements are saved with the session history. Reconnecting keeps the latest in-app exact result anchored while fresh lifecycle state is restored; **Stats → Throughput** scans durable records into its separate historical cache. Data begins with generations recorded after this feature was added.

Forked sessions deliberately omit the source session's throughput measurements, so a fork starts a new throughput history.
