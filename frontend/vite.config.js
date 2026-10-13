import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: 'index.html', rolling: 'rolling.html' } } },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    proxy: { '/shop-api': { target: 'http://127.0.0.1:8001', changeOrigin: false } },
  },
  preview: {
    host: '127.0.0.1',
    proxy: { '/shop-api': { target: 'http://127.0.0.1:8001', changeOrigin: false } },
  },
});
