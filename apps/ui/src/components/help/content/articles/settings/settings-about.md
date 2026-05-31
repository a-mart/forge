The About pane shows Forge's current version and provides access to updates and release information.

## Version

The version badge shows the running version number. Click the GitHub releases link to see the full changelog and download history.

## Updates (desktop app)

In the Electron desktop app, this pane manages automatic updates:

- **Check for Updates** — manually check if a newer version is available.
- **Download Update** — download a discovered update. A progress bar shows download status.
- **Restart to Install** — once downloaded, restart the app to apply the update.

Update status messages show the current state: checking, up to date, available, downloading, or ready to install.

## Beta channel

Enable **Include beta updates** to get early access to pre-release versions. Beta releases ship new features sooner but may be less stable. Toggle it off to return to the stable release channel.

## Browser mode

When running Forge in a browser (not the desktop app), the update controls are hidden. Updates are managed through your deployment process instead.

## Troubleshooting

If an update check fails, verify your network connection and try again. The error message from the update service is shown in the status line.
