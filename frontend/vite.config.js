import { defineConfig } from 'vite';

export default defineConfig({
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
