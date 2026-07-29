**Use Chrome with Forge** is the optional setup and repair page for Forge Desktop's Automatic Browser experience.

Forge deploys a pinned unpacked extension and native-messaging host for the active Forge data directory. Complete setup once for every Chrome profile and `FORGE_DATA_DIR` you intend to use:

1. Open `chrome://extensions` in the Chrome profile you want Forge to use.
2. Enable Developer mode.
3. Choose **Load unpacked** and select the exact extension folder shown by Forge.
4. Confirm extension ID `fcchfcnadajoejfbiclihglkmbcfhajd` in Chrome or Forge's advanced diagnostics.
5. Return to Forge and choose **Use Chrome with Forge**.

After setup, the enabled and authenticated Forge extension grants profile-wide access to eligible ordinary web tabs. `browser_status` exposes a bounded **eligibleTabs** inventory across ready authenticated profiles. A tabless `browser_open` with `reuseExistingTab` enabled (the default) selects the active or most recently accessed eligible tab without requiring Chrome or the operating system to be focused; pass an inventory `tabId` to select that exact tab. `reuseExistingTab: false`, or no eligible tab, may create an inactive neutral `about:blank` tab for one authorized initial navigation. Non-open operations remain sticky to the selected logical tab.

There is no Chrome profile confirmation prompt or picker. You do not attach tabs, choose hosts, manage groups, or release leases. Chrome-internal and other restricted pages remain excluded by the platform capability.

Open **Advanced diagnostics** only when setup or repair fails. It shows coordinator, authentication, recovery, and extension identity state. If **Recovery** reports `manual-extension-reload`, reload Forge's unpacked extension from `chrome://extensions`, then refresh Settings. Chrome-backed tabs stay in Chrome and do not support embedded-only recording, viewport resize, screenshot-export, or dock/pop-out controls.
