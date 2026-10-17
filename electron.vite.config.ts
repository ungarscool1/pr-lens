import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // The impact analyzer uses the compiler API at runtime. Bundle it so the packaged app does
  // not depend on development-only node_modules being present beside the app.
  main: { build: { externalizeDeps: { exclude: ['typescript'] } } },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
