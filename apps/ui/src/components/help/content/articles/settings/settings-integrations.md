The Integrations pane connects Forge to external messaging services. Currently, Telegram is the main supported integration.

## Configuration scope

Integration settings can be shared or per-profile:

- **Shared (all managers)** — the default. Settings apply to every manager that doesn't have a custom override.
- **Per-profile** — select a specific manager to create an override that takes priority over shared settings.

Pick the scope from the dropdown at the top of the pane. When you select a specific profile, any changes you make apply only to that profile's integration config.

## Adding an integration

1. Select the configuration scope (shared or a specific manager).
2. Configure the integration settings (see the Telegram article for details).
3. Click **Save**.
4. Use **Test connection** to verify the setup works.

## Disabling

Click **Disable** to turn off an integration without deleting its config. You can re-enable it later by toggling it back on and saving.

## Troubleshooting

- **Test connection fails** — check the bot token, make sure the bot is not being used by another service, and verify your network allows outbound HTTPS to the provider's API.
- **Messages aren't delivered** — confirm the integration is enabled and the allowed user list includes your user ID (or is empty, which allows all users).
