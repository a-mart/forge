External Chrome (Local Beta) is an intentionally unpacked, local-only Forge Desktop integration. It is not installed or updated through the Chrome Web Store. Forge deploys a pinned extension folder and native-messaging host for the active Forge data directory; you choose which Chrome profiles load it.

It requires Chrome 125+. Chrome shows normal Developer Mode/unpacked warnings, and enterprise policy may block Developer Mode or unpacked extensions.

## Permissions and privacy

The V1 extension declares access to all websites and powerful Chrome permissions, including debugger, bookmarks, history, downloads, top sites, tabs, sessions, navigation, scripting, storage, tab groups, notifications, side panel, and native messaging, plus optional download-open authority.

That is a broad declared V1 permission set, not a list of active features. Current Local Beta code does not read bookmarks, history, or top sites or open downloaded files. The startup shell registers download-change notifications, but the payload ignores them: Forge provides no managed download workflow or saved download artifacts.

Forge does not copy Chrome credentials, Chrome profile databases, official Chrome profile names, bookmarks, history, or top sites. Once you attach a page, snapshots and operations can expose its content, accessibility data, bounded console/network/action diagnostics, URL/title, a bounded PNG, authenticated actions, and arbitrary JavaScript to the active turn.

Use a dedicated Chrome profile containing only the accounts needed for Forge work. Do not begin with an everyday profile.

## Load the unpacked extension

Set up the integration once per Chrome profile and Forge data directory:

1. Open the intended dedicated Chrome profile.
2. Manually enter `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. In Forge, open **Settings → External Chrome (Local Beta)** and confirm **Validated Load unpacked folder** is **ready**.
5. Click **Load unpacked** in Chrome and choose the exact folder shown by Forge. This is the stable folder for that Forge data directory; do not choose its parent or a payload subfolder.
6. Confirm Chrome shows extension ID `fcchfcnadajoejfbiclihglkmbcfhajd`. If it differs, remove that extension and do not enable the integration.
7. Compare the packaged/deployed identity and native-host state, then confirm **Enable**.
8. Repeat in every additional Chrome profile, and repeat when using another Forge data directory.

Forge does not open Chrome settings pages, enumerate profiles, or install the extension automatically.

Compatible connected profiles auto-reload after a Forge update or rollback. Use Chrome's manual **Reload** only when Settings reports **Manual extension reload required**. When that status appears, compare versions/hashes, open `chrome://extensions`, and reload Forge External Chrome in each affected profile.

## Attach and detach

Open **Browser**, choose **External Chrome**, select a connected extension instance, and review candidate tabs. Editable profile aliases are Forge-local display state, not Chrome's official profile names. Restricted pages, debugger conflicts, and tabs leased elsewhere cannot be selected.

External Chrome operates only the session's bounded leased tab set: tabs you confirm, tabs Forge creates through `open` in the selected or sole connected profile, and qualifying grouped child tabs when you explicitly enable that policy.

A confirmed attachment grants one session lease over that bounded tab set. Leases persist until turn disposition, **Detach now**, lifecycle release, bounded expiry, or loss. Switching the selected Browser host is only a preference change and does not detach. DevTools or trusted human input interrupts agent control. Detach leaves tabs open.

External Chrome supports status, grouped create/open, navigation, snapshot, click, type, press, scroll, evaluate, and wait. It does not support physical resize, recordings, download handling or saved artifacts, opening downloaded files, standalone screenshot export controls, or dock/pop-out. Snapshot can return transient screenshot data, but there is no standalone screenshot toolbar/export workflow. Browser recordings are Managed Browser-only.

## Status, repair, and ownership

The pane reports Forge coordinator ownership, local authentication, native registration/trust, the validated unpacked path, and packaged/deployed/running versions and SHA-256 values when available.

- **Repair native host** repairs Forge-owned registration and may rotate local authentication. It does not inspect or change Chrome profiles or tabs.
- **Roll back** selects the last verified compatible payload/native host when one exists. Compatible profiles auto-reload; use manual reload only when prompted.
- **Take over stale owner** transfers stale Forge coordinator/native-host ownership. It never takes over Chrome profiles or tabs, and must not be used while the prior Forge instance is live.
- **Remove integration** releases recoverable leases, disables and unregisters Forge's native integration, and removes local authentication. Remove the unpacked extension manually from every Chrome profile afterward; tabs remain open.

All state-changing actions require confirmation and remain disabled when Forge cannot validate them safely. See **Browser Automation** help for normal attach/lease/lifecycle behavior.
