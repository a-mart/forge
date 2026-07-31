/**
 * Backend unit/integration tests run as ordinary Node processes, never as the
 * Electron main process. Do not inherit Electron development's ABI-specific
 * SQLite binding from a concurrently running desktop development session.
 *
 * Electron-path tests opt in explicitly with `vi.stubEnv` and production still
 * enforces the binding requirement whenever it actually runs under Electron.
 */
process.env.FORGE_ELECTRON_DEV = "0";
delete process.env.FORGE_BETTER_SQLITE3_NATIVE_BINDING;
