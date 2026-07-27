Forge Desktop presents one **Browser** experience for local Builder managers. Browser is not a Skill and is not forwarded to Remote Projects or Collaboration.

Forge chooses the available local target automatically:

- A Chrome-backed tab stays in Chrome. The Browser rail shows a compact card with **Show in Chrome**.
- An embedded tab appears inside Forge and includes navigation, viewport, screenshot, recording, and dock/pop-out controls.
- If Chrome is unavailable or an operation requires an embedded capability, Forge uses the embedded browser automatically.

There is no host picker, tab attachment flow, or lease management UI. If more than one genuinely eligible Chrome profile is available, Forge asks once which profile to use for the current Forge session.

## Chrome setup

Open **Settings → Use Chrome with Forge** for the one-time extension setup or repair. After setup, Forge creates or uses browser tabs automatically. Chrome-backed tabs do not show unsupported recording, viewport, screenshot-export, or dock/pop-out controls.

## Privacy and persistence

Chrome page URLs and titles are not persisted in Forge browser state. Embedded-browser cookies and site storage use Forge's persistent local browser partition. Successfully stopped embedded recordings persist under the session's `artifacts/browser/` directory.

Browser state is delivered through the same live, bootstrap, and replay paths as the rest of the session. Clearing conversation history does not clear browser state; archive and deletion release active browser authority.
