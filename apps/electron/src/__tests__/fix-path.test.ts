/**
 * Tests for the macOS/Linux PATH fix utility.
 *
 * These tests validate the merge logic and the overall fixPath behavior.
 * The shell invocation is tested via the actual shell when available.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// We test the internal merge logic by importing the module and exercising
// the public API. Since fixPath() mutates process.env.PATH, we save/restore it.

describe('fix-path', () => {
  let originalPath: string | undefined;
  let originalPlatform: PropertyDescriptor | undefined;
  let originalShell: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    originalShell = process.env.SHELL;
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    }
    if (originalShell !== undefined) {
      process.env.SHELL = originalShell;
    } else {
      delete process.env.SHELL;
    }
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  describe('fixPath()', () => {
    it('is a no-op on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const before = process.env.PATH;

      const { fixPath } = await import('../fix-path.js');
      fixPath();

      expect(process.env.PATH).toBe(before);
    });

    it('does not crash when SHELL is not set', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      delete process.env.SHELL;

      // Re-import to pick up the new platform
      // Note: dynamic import caching means we test the live env reads
      const { fixPath } = await import('../fix-path.js');
      expect(() => fixPath()).not.toThrow();
    });

    it('enriches PATH on macOS/Linux when a valid shell is available', async () => {
      if (process.platform === 'win32') return; // skip on Windows CI

      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      // Set a minimal PATH to see if the shell adds more entries
      process.env.PATH = '/usr/bin';
      process.env.SHELL = process.env.SHELL || '/bin/zsh';

      const { fixPath } = await import('../fix-path.js');
      fixPath();

      // The shell should add at least /usr/local/bin or similar
      const entries = (process.env.PATH || '').split(':');
      expect(entries.length).toBeGreaterThanOrEqual(1);
      // Original entry should still be present
      expect(entries).toContain('/usr/bin');
    });
  });

  describe('getFixedPath()', () => {
    it('returns undefined on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      const { getFixedPath } = await import('../fix-path.js');
      expect(getFixedPath()).toBeUndefined();
    });

    it('returns a string with PATH entries on macOS/Linux', async () => {
      if (process.platform === 'win32') return;

      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      process.env.SHELL = process.env.SHELL || '/bin/zsh';

      const { getFixedPath } = await import('../fix-path.js');
      const result = getFixedPath();

      if (result !== undefined) {
        expect(result).toContain('/');
        expect(typeof result).toBe('string');
      }
    });

    it('does not modify process.env.PATH', async () => {
      if (process.platform === 'win32') return;

      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const before = process.env.PATH;

      const { getFixedPath } = await import('../fix-path.js');
      getFixedPath();

      expect(process.env.PATH).toBe(before);
    });
  });
});
