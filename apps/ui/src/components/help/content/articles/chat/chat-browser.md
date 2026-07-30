Forge Desktop presents one **Automatic Browser** experience for local Builder managers. The Automatic Browser is not a Skill and is not forwarded to Remote Projects or Collaboration.

Forge chooses the available local target automatically:

- A Chrome-backed tab stays in Chrome. The Browser rail shows a compact card with **Show in Chrome**.
- An embedded tab appears inside Forge and includes navigation, viewport, screenshot, recording, and dock/pop-out controls.

When the Forge extension is enabled and authenticated, Forge can access eligible ordinary web tabs across that Chrome profile. `browser_status` provides a bounded **eligibleTabs** inventory across ready authenticated profiles; its bounded URL/title/profile/window/activity/focus/last-access details may transiently reach the manager/model for selection, but are not shown in Browser workspace UI or copied into canonical renderer state and are redacted from persistence. For a tabless `browser_open` (reuse enabled by default), Forge selects the active or most recently accessed eligible tab without requiring Chrome or the operating system to be focused. Pass an inventory `tabId` to select that exact tab. With `reuseExistingTab: false`, or when no eligible tab exists, Forge may create an inactive neutral `about:blank` tab for one authorized initial navigation. After an open selects a logical tab, non-open operations remain sticky; explicit Chrome-backed tabs do not migrate and unsupported operations fail on that tab.

Normal supported navigation stays on the same Chrome-backed tab. Forge may briefly retain internal control between nearby actions, but you do not attach or release anything yourself. A trusted click, key press, touch, or wheel gesture interrupts agent control; Forge settles the in-flight command and requires a fresh snapshot before another potentially changing action. Ordinary idle pointer movement does not interrupt. **Take Control** releases the exact Chrome authority for terminal human takeover. DevTools or another debugger, a restricted or unproven target, a lost tab, transport uncertainty, timeout, update, turn end, or shutdown can also interrupt and reconcile it. Forge never silently migrates an explicit Chrome target or replays an action that may have changed the page; retry only after inspecting the current tab.

There is no Chrome profile confirmation prompt or picker, host picker, tab attachment flow, or lease-management UI. Chrome-internal and other restricted pages remain excluded by the platform capability.

## Chrome setup

Open **Settings → Use Chrome with Forge** to set up each Chrome profile and Forge data directory, or to repair the integration. After setup, Forge creates or uses browser tabs automatically. Chrome-backed tabs do not show unsupported recording, viewport, screenshot-export, or dock/pop-out controls.

## External Chrome snapshot size limits

External Chrome adapts PNG capture to the page's device pixel ratio and viewport, without upscaling smaller pages. It will not claim success below its useful minimum capture size; if the image still cannot fit at that floor, the snapshot fails with a typed `response-too-large` result. The PNG is not silently dropped. When the complete successful snapshot response would exceed its bounded relay envelope, Forge deterministically omits optional diagnostics, accessibility nodes, visible-text characters, and interactive elements as needed to fit. The response reports positive omission counts in `compaction.omitted`; `compaction` is absent when nothing was omitted.

If the screenshot alone cannot fit, Forge returns the typed, non-retryable `response-too-large` failure. It does not drop the image or send an oversized response; callers should rely on the error code and retryability rather than optional diagnostic details.

## Privacy and persistence

Chrome page URLs/titles, tab error detail, and page-identifying action fields are redacted before persistence. Embedded-browser cookies and site storage use Forge's persistent local browser partition. Successfully stopped embedded recordings persist under the session's `artifacts/browser/` directory.

Canonical logical browser state is persisted separately from conversation history and reaches the UI through live updates and selected-session bootstrap snapshots; transient `eligibleTabs` inventory is not part of that state, and conversation replay does not reconstruct it. Clearing conversation history does not clear browser state. Archive remains fail-closed when a browser release cannot be acknowledged; deletion is terminal and treats browser revocation as best-effort, clearing Desktop/External Chrome session state and checkpoints so stale lifecycle state cannot block deletion. If release reconciliation is still pending, Forge blocks new Chrome control rather than guessing another tab.
