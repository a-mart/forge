**Use Chrome with Forge** is the optional one-time setup and repair page for Forge Desktop's automatic Browser experience.

Forge deploys a pinned unpacked extension and native-messaging host for the active Forge data directory. To finish setup:

1. Open `chrome://extensions` in the Chrome profile you want Forge to use.
2. Enable Developer mode.
3. Choose **Load unpacked** and select the folder shown by Forge.
4. Return to Forge and choose **Use Chrome with Forge**.

After setup, return to the Browser rail. Forge selects Chrome automatically when it is ready and falls back to the embedded browser when necessary. You do not attach tabs, choose hosts, manage groups, or release leases.

When multiple ready Chrome profiles remain genuinely ambiguous, Forge asks once for the current Forge session with generic labels and a **Use embedded browser** option. A confirmed Chrome choice stays in memory only until Forge quits; it is not a durable host preference.

Open **Advanced diagnostics** only when setup or repair fails. It shows coordinator, authentication, recovery, and extension identity state. Chrome-backed tabs stay in Chrome and do not support embedded-only recording, viewport resize, screenshot-export, or dock/pop-out controls.
