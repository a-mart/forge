External Chrome (Local Beta) is an intentionally unpacked, local-only Forge Desktop integration. It is not installed or updated through the Chrome Web Store. Forge deploys a pinned extension folder and a native-messaging host, while you choose which Chrome profiles load the extension.

## Security boundary

The extension can access all websites and requests powerful Chrome permissions, including debugger, history, bookmarks, downloads, top sites, tabs, sessions, navigation, scripting, storage, tab groups, notifications, side panel, and native messaging. Those capabilities can expose page content, browsing activity, downloads, and authenticated actions.

Use a dedicated Chrome profile containing only the accounts needed for Forge work. Do not begin with an everyday profile. Forge does not inspect Chrome profiles, copy browser credentials, open `chrome://` pages, or install the extension automatically.

## Load the unpacked extension

Repeat this ceremony separately in every Chrome profile you intend to use:

1. Open the dedicated Chrome profile.
2. Manually enter `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. In Forge, open **Settings → External Chrome (Local Beta)** and confirm the unpacked folder status is **ready**.
5. Click **Load unpacked** in Chrome and choose the exact validated folder shown by Forge. Do not choose its parent or a payload subfolder.
6. Confirm Chrome shows extension ID `fcchfcnadajoejfbiclihglkmbcfhajd`. If it differs, remove that extension and do not enable the integration.
7. Enable the local coordinator in Forge only after the path, ID, native-host state, versions, and hashes look correct.

After every Forge Desktop update, compare the packaged and deployed inventory, then click **Reload** on the extension card in each Chrome profile. Chrome does not perform that reload for this unpacked Local Beta.

## Status and repair

The Settings pane reports coordinator ownership, local authentication, native registration/trust, the validated unpacked path, and packaged/deployed component versions and SHA-256 values when available. It does not guess running Chrome versions before an authenticated runtime connection reports them.

- **Repair native host** repairs Forge-owned registration and may rotate local authentication. It does not inspect or change Chrome profiles.
- **Roll back** selects the last validated payload/native host when one exists. Reload the extension manually afterward.
- **Take over stale owner** is available only when an earlier Forge Desktop ownership record is stale. Do not use it while another instance is running.
- **Remove integration** disables and unregisters Forge's native integration. Remove the unpacked extension manually from every Chrome profile.

All destructive or ownership-changing actions require confirmation. Unsupported or unsafe actions remain disabled based on the coordinator's validated local status.
