The **Stream Deck** settings page connects a local Elgato Stream Deck plugin to Forge Desktop. It is optional and Builder-only; it does not expose controls to Remote Projects or Collaboration servers.

## Pair a device

Install the Forge Stream Deck plugin, then open **Settings → Stream Deck** in Forge Desktop. Start pairing from the plugin and approve the matching request in Forge. Pairing creates a device-specific local credential; do not approve a code you did not just request on a device you control.

After pairing, the page lists the approved device. You can revoke a device at any time. Revocation removes that device's access until it is paired again.

## What the plugin can do

The plugin provides bounded shortcuts for local Builder sessions, such as opening a session, sending an allowed command, or displaying status. It is not a general remote-control channel: its actions remain constrained by the local Forge access policy and current session state.

Keep Forge Desktop and the Stream Deck software running while using the plugin. If the plugin shows disconnected, verify that the local Forge backend is available, then reconnect or pair again if the device was revoked.
