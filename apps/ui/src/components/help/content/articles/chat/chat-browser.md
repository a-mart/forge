Forge Desktop presents one **Automatic Browser** experience for local Builder managers. The Automatic Browser is not a Skill and is not forwarded to Remote Projects or Collaboration.

Forge chooses the available local target automatically:

- A Chrome-backed tab stays in Chrome. The Browser rail shows a compact card with **Show in Chrome**.
- An embedded tab appears inside Forge and includes navigation, viewport, screenshot, recording, and dock/pop-out controls.

When the Forge extension is enabled and authenticated, Forge can access eligible ordinary web tabs across that Chrome profile. `browser_status` provides a bounded **eligibleTabs** inventory across ready authenticated profiles. For a tabless `browser_open` (reuse enabled by default), Forge selects the active or most recently accessed eligible tab without requiring Chrome or the operating system to be focused. Pass an inventory `tabId` to select that exact tab. With `reuseExistingTab: false`, or when no eligible tab exists, Forge may create an inactive neutral `about:blank` tab for one authorized initial navigation. After an open selects a logical tab, non-open operations remain sticky; explicit Chrome-backed tabs do not migrate and unsupported operations fail on that tab.

There is no Chrome profile confirmation prompt or picker, host picker, tab attachment flow, or lease-management UI. Chrome-internal and other restricted pages remain excluded by the platform capability.

## Chrome setup

Open **Settings → Use Chrome with Forge** to set up each Chrome profile and Forge data directory, or to repair the integration. After setup, Forge creates or uses browser tabs automatically. Chrome-backed tabs do not show unsupported recording, viewport, screenshot-export, or dock/pop-out controls.

## Privacy and persistence

Chrome page URLs/titles, tab error detail, and page-identifying action fields are redacted before persistence. Embedded-browser cookies and site storage use Forge's persistent local browser partition. Successfully stopped embedded recordings persist under the session's `artifacts/browser/` directory.

Browser state is persisted separately from conversation history and reaches the UI through live updates and selected-session bootstrap snapshots; conversation replay does not reconstruct it. Clearing conversation history does not clear browser state; archive and deletion release active browser authority.
