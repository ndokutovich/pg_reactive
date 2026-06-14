import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Keep original (non-realpath) module paths so the jsdom environment resolves
  // test files on subst/symlinked checkouts (e.g. a Windows `subst` drive whose
  // real target is on another drive). No-op on CI where there are no symlinks.
  resolve: { preserveSymlinks: true },
  test: {
    exclude: ['dist/**', 'node_modules/**'],
  },
});
