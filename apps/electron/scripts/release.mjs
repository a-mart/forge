const message = `
[electron/release] Deprecated release entrypoint

This repository-level script is intentionally disabled.
It is unsafe for official desktop releases because it can bypass the guarded build-first,
draft-first flow and publish the wrong version or an incomplete updater asset set.

Use the desktop release golden path instead:
1. Bump apps/electron/package.json and push that commit before any release build.
2. Build and validate macOS locally with pnpm package:electron.
3. Trigger the Windows build via GitHub Actions workflow_dispatch.
   - Pushes to electron/* branches are validation-only and do not publish a release.
4. Create a GitHub Release as a draft.
5. Upload the full updater asset set from both platforms, including installer/archive files,
   latest*.yml metadata, and any generated *.blockmap files.
6. Publish only after both platforms are validated and all assets are attached.

See apps/electron/README.md for the current release workflow.
`

console.error(message.trim())
process.exit(1)
