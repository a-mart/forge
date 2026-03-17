/**
 * Pre-startup data directory migration check.
 *
 * Runs BEFORE concurrently starts the backend + UI so the interactive
 * prompt has full TTY access. Sets FORGE_DATA_DIR in the environment
 * so the backend child process picks up the chosen path without
 * re-prompting.
 *
 * Usage: node scripts/check-data-migration.mjs
 */

const { checkDataDirMigration } = await import("../apps/backend/dist/startup-migration.js");
await checkDataDirMigration();
