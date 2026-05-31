When agents produce code artifacts, Forge can open files directly in your preferred editor. This setting controls which editor is launched when you click a file link in the artifact panel or chat.

## Supported editors

- **VS Code Insiders** — uses the `vscode-insiders://` URL scheme
- **VS Code** — uses the `vscode://` URL scheme
- **Cursor** — uses the `cursor://` URL scheme

## How to change

Open **Settings > General**. Under Appearance, pick your editor from the Preferred Editor dropdown. The setting is stored in your browser and takes effect on the next file-open action.

## How it works

File links in the artifact sidebar and chat transcript use the selected editor's URL scheme to open files at the correct path. Your editor needs to be installed and registered as a handler for its URL scheme. Most editors do this automatically during installation.

If clicking a file link does nothing, check that the editor is installed and that your OS recognizes the URL scheme. On macOS, you may need to open the editor once after installation so it registers itself.
