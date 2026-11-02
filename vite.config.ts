import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = `http://127.0.0.1:${process.env.PORT ?? 4317}`;

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    proxy: {
      '/api': server,
      '/mcp': server,
      '/media': server,
      '/exports': server,
      '/fonts': server,
      '/ws': { target: server, ws: true },
    },
  },
});
