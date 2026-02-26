import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/studio/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'query-vendor': ['@tanstack/react-query', '@tanstack/react-table'],
          'codemirror-vendor': [
            '@codemirror/state', '@codemirror/view', '@codemirror/lang-sql',
            '@codemirror/theme-one-dark',
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/auth': 'http://127.0.0.1:8080',
      '/rest': 'http://127.0.0.1:8080',
      '/health': 'http://127.0.0.1:8080',
    },
  },
});
