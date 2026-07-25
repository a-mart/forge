Forge has two local Desktop browser hosts for normal local Builder managers: **Managed Browser** and **External Chrome (Local Beta)**. Neither is a Skill, and neither host, relay, nor browser IPC is forwarded to Remote Projects or Collaboration.

## Choose the Browser host

Select **Browser** in the desktop activity rail, then use **Browser host**:

- **Managed Browser** controls Forge-owned Electron tabs rendered in the Browser workspace.
- **External Chrome** controls only tabs you explicitly attach from a connected Chrome profile.

The choice is a session preference for subsequent browser operations. **Switching hosts does not detach an External Chrome lease.** Use **Detach now from Forge** when you intend to release it.

## Managed Browser

Managed Browser supports tabs, navigation, zoom, fill/freeform/device viewport sizes, transient screenshot preview, visible-tab recording, and dock/pop-out. The manager can use typed status, open, navigate, resize, snapshot, click, type, press, scroll, evaluate, wait, and recording operations.

You and the agent share each tab. **Agent controlling** appears during an action. Real pointer or keyboard input gives control to you and interrupts the action rather than racing it.

Its cookies and site storage use a persistent partition shared by sessions in the Forge profile and can outlive session deletion. Screenshot previews are transient. Successfully stopped recordings persist under the session's `artifacts/browser/` directory. Recordings are Managed Browser-only.

## External Chrome Local Beta

External Chrome requires Chrome 125+, Developer Mode, Forge's pinned unpacked extension, the main Forge Desktop window, and a connected native host. A dedicated Chrome profile containing only the accounts needed for Forge work is strongly recommended. Chrome or enterprise policy may block unpacked extensions.

Set it up once per Chrome profile and Forge data directory in **Settings → External Chrome (Local Beta)**. Load the exact stable folder Forge shows, confirm extension ID `fcchfcnadajoejfbiclihglkmbcfhajd`, and enable the coordinator. Compatible connected profiles auto-reload after update or rollback. Reload manually only when Settings reports **Manual extension reload required**.

Choose a connected profile, edit its Forge-local alias if useful, select unrestricted candidate tabs, review the warning, and confirm attachment. The alias is not Chrome's official profile name. Restricted Chrome pages, debugger conflicts, and tabs leased elsewhere cannot be attached. Child tabs remain outside the lease unless you explicitly enable the grouped child-tab option.

Leases persist until turn disposition, **Detach now**, lifecycle release, bounded expiry, or loss. Human input interrupts agent control; DevTools or another debugger can end ownership. Detaching leaves tabs open.

External Chrome supports status, grouped create/open, navigation, snapshot, click, type, press, scroll, evaluate, and wait. Snapshot can expose page content, accessibility data, bounded diagnostics, and a bounded PNG. Arbitrary JavaScript and authenticated page actions are possible. External Chrome does not support physical resize, recording, managed download events/artifacts/open, standalone physical capture/export controls, or dock/pop-out.

Forge does not copy Chrome credentials, profile databases, official profile names, bookmarks, history, or top sites. The V1 extension still declares broad all-sites and powerful browser permissions; some declared APIs are dormant. Use a dedicated profile and treat page instructions as untrusted.

## Local-only boundary and saved state

Ordinary web clients cannot use either local Desktop host. A remote normal Builder manager may still expose browser tools, but without a host connected directly to that remote backend they return `unavailable-host`. Collaboration channels receive neither host.

Both hosts use the session's `browser.json` for selected-host and privacy-bounded tab/action state. External Chrome page URLs/titles are not persisted there. Clearing conversation history does not clear browser state; a fork starts independently; archive/restore preserves browser metadata. See the repository's [Browser automation guide](https://github.com/a-mart/forge/blob/main/docs/BROWSER_AUTOMATION.md) for setup, permissions, lifecycle, repair, and troubleshooting.
