Generation throughput shows how quickly eligible model calls produce output. It is a performance signal, not a measure of the whole agent run: time in tools and gaps between model calls are not included.

## Availability

Throughput is currently recorded only for manager and worker model calls that run through the **Pi runtime**. A provider appearing in a model selector does not make every runtime eligible; other runtime paths do not add throughput records.

## Header and worker indicators

For an eligible local manager, the header keeps one fixed throughput control visible. While a generation is active it uses a restrained activity pulse and holds the latest exact completed call value dimmed, or shows `— tok/s` until an exact result exists. It never estimates a live rate from streamed text.

When provider-final output usage, a first-output boundary, and a positive generation duration are available at completion, the control updates to the exact final `tok/s` value. Open it to see the latest generation's final rate, TTFT, output tokens, and model/provider. Missing final usage, a missing output boundary, a zero-duration span, or an interrupted generation does not show `0 tok/s` or promote a prior value as the current call.

Active worker pills and Quick Look reserve a throughput cell from the start. They show the final provider value or `—`; they do not show an approximate live rate.

## Throughput statistics

Open **Stats → Throughput** for historical manager/worker totals, role comparison, daily model trends, model summaries, and recent calls. The view is local to Builder even while a Remote Project is selected. Filter by range (including a custom range), project, role, provider/model, attribution, or specialist.

- **All measured** (the default) includes terminal calls with provider-final output and a usable observed stream boundary.
- **Strict boundaries** requires observed output through stream end.
- **All calls** also exposes unmeasured or incomplete lifecycle records for coverage, but does not assign them a rate.

The historical top-line rate is token weighted: provider-final output tokens divided by the sum of first-output-to-stream-end duration. Provider-output `tok/s` includes provider-reported reasoning tokens when available. An agent-level Pi retry is a separate call; provider-internal retries and Codex WebSocket replays are not timed as separate rates.

## History and forks

Terminal measurements are saved with the session history. Reconnecting keeps the latest in-app exact result anchored while fresh lifecycle state is restored; **Stats → Throughput** scans durable records into its separate historical cache. Data begins with generations recorded after this feature was added.

Forked sessions deliberately omit the source session's throughput measurements, so a fork starts a new throughput history.
