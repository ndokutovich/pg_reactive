import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { realpathSync } from 'fs';

// Resolve through Windows junctions/symlinks so Rollup sees a consistent root
const root = realpathSync.native(process.cwd());

export default defineConfig({
  root,
  plugins: [svelte()],
  server: {
    port: 5175
  }
});
