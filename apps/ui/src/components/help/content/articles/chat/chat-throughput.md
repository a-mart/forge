Generation throughput shows how quickly eligible model calls produce output. It is a performance signal, not a measure of the whole agent run: time in tools and gaps between model calls are not included.

## Availability

Throughput is currently recorded only for manager and worker model calls that run through the **Pi runtime**. A provider appearing in a model selector does not make every runtime eligible; other runtime paths do not add throughput records.

## Live indicators

During an eligible manager generation, the header's throughput control starts at **Measuring…**. Once Forge has enough streamed output for a local estimate, it shows `≈ tok/s`. When the provider supplies final output usage at completion, the final rate replaces that estimate.

An active eligible worker can show the same approximate rate on its green pill and in its Quick Look. Open the manager header control to see the current estimate, the call average, and, when data qualifies, the weighted summary for the last 20 measured manager/worker generations in that session.

Missing final usage, a missing output boundary, a zero-duration span, or a generation still in progress is not shown as `0 tok/s`. Forge leaves the rate unavailable instead of inventing one.

## Throughput statistics

Open **Stats → Throughput** for historical manager/worker totals, role comparison, daily model trends, model summaries, and recent calls. The view is local to Builder even while a Remote Project is selected. Filter by range (including a custom range), project, role, provider/model, attribution, or specialist.

- **All measured** (the default) includes terminal calls with provider-final output and a usable observed stream boundary.
- **Strict boundaries** requires observed output through stream end.
- **All calls** also exposes unmeasured or incomplete lifecycle records for coverage, but does not assign them a rate.

Provider-output `tok/s` includes provider-reported reasoning tokens when available. An agent-level Pi retry is a separate call; provider-internal retries and Codex WebSocket replays are not timed as separate rates.

## History and forks

Terminal measurements are saved with the session history. Reconnecting or restarting Forge rebuilds the bounded last-20 session summary from manager and worker records, and the Throughput tab scans the same durable records into its separate historical cache. Data begins with generations recorded after this feature was added.

Forked sessions deliberately omit the source session's throughput measurements, so a fork starts a new throughput history.
