**Use Chrome with Forge** is the optional setup and repair page for Forge Desktop's Automatic Browser experience.

Forge deploys a pinned unpacked extension and native-messaging host for the active Forge data directory. Complete setup once for every Chrome profile and `FORGE_DATA_DIR` you intend to use:

1. Open `chrome://extensions` in the Chrome profile you want Forge to use.
2. Enable Developer mode.
3. Choose **Load unpacked** and select the exact extension folder shown by Forge.
4. Confirm extension ID `fcchfcnadajoejfbiclihglkmbcfhajd` in Chrome or Forge's advanced diagnostics.
5. Return to Forge and choose **Use Chrome with Forge**.

After setup, return to the Browser rail. For a tabless request, Forge can select Chrome automatically when it is ready or use the embedded browser when fallback remains safe. An explicit Chrome-backed tab never migrates. You do not attach tabs, choose hosts, manage groups, or release leases.

When multiple ready Chrome profiles remain genuinely ambiguous, Forge asks once for the current Forge session with generic labels and a **Use embedded browser** option. A confirmed Chrome choice stays in memory only until Forge quits; it is not a durable host preference.

Open **Advanced diagnostics** only when setup or repair fails. It shows coordinator, authentication, recovery, and extension identity state. If **Recovery** reports `manual-extension-reload`, reload Forge's unpacked extension from `chrome://extensions`, then refresh Settings. Chrome-backed tabs stay in Chrome and do not support embedded-only recording, viewport resize, screenshot-export, or dock/pop-out controls.
