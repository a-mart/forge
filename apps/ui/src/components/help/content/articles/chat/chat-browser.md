Managed Browser is a Forge Desktop capability, not a Skill. It controls Forge-owned Electron tab views for the selected local Builder manager. It does not attach to your everyday Chrome profile, and local browser IPC is not forwarded to Remote Projects or Collaboration channels.

## Open the Browser workspace

Select **Browser** in the desktop activity rail while a local manager session is selected. Browser replaces the main Chat/Files/Source Control workspace until you return to another rail surface; Terminal remains independent.

Use the workspace to:

- open, switch, and close tabs;
- enter an address or go back, forward, reload, or hard reload;
- change zoom and viewport size, including device presets;
- capture a transient screenshot preview; and
- start or stop a recording of the visible tab.

An agent can reveal Browser when it opens a visible tab. The current session's tabs stay separate from tabs belonging to other sessions.

On macOS, Windows, and Linux, **Open Managed Browser in a separate window** moves the same live tab into one dedicated native window. Dock it with the toolbar control, the title-bar close button, Cmd+W on macOS, or Ctrl+W on Windows/Linux. Page state, history, profile storage, automation, and an active recording continue because Forge reparents the same native view instead of remounting it. The main window remains the only backend browser host and recording authority; there is no remount fallback.

## Work alongside the manager

Normal Builder managers have typed operations for status, open, navigate, resize, snapshot, click, type, key presses, scroll, JavaScript evaluation, waiting, and recording. **Agent controlling** appears during an agent action. If you click or type in the page, your input takes control and interrupts that action instead of racing it. The manager should inspect the page again before retrying.

Managed Browser can execute arbitrary JavaScript and interact with authenticated page content. Treat page instructions as untrusted, review consequential actions, and avoid exposing secrets unnecessarily.

## Availability

A connected Forge Desktop browser host is required. In an ordinary web client the Browser workspace reports **Browser host unavailable** and does not attempt local browser IPC. Remote normal Builder managers may still know the typed tools, but calls return `unavailable-host`; the viewing machine's Desktop host is not forwarded to the remote server. Collaboration channels do not receive Managed Browser access.

There is no Managed Browser environment variable or Settings → Skills toggle. The separate `agent-browser` Skill uses a different browser process and trust boundary.

## Saved state and recordings

Tab metadata and recent safe action summaries persist with the Forge session. Cookies and site storage are shared by sessions in the same Forge profile through a persistent Electron partition and can remain after a session is deleted. Deleting a session removes its tab metadata and completed browser recordings, not that profile partition. **Clear managed browser data** is not currently a shipped control.

Screenshot previews are transient. Successfully stopped recordings persist under the session's `artifacts/browser/` directory. Archiving unhosts tabs but preserves their metadata and completed recordings for restore; clearing the conversation does not clear browser data, and a fork starts with independent browser state.

See the repository's [Managed Browser guide](https://github.com/a-mart/forge/blob/main/docs/BROWSER_AUTOMATION.md) for the complete operation, security, persistence, and comparison reference.
