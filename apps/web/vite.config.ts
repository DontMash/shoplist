import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Generates manifest.webmanifest + a Workbox service worker (sw.js) at
    // build time and injects the manifest link into index.html.
    VitePWA({
      // The service worker activates as soon as an update is found; the new
      // shell is served on the next visit/reload.
      registerType: 'autoUpdate',
      // Registration lives in src/main.tsx via `virtual:pwa-register`.
      injectRegister: null,
      // public/ files (incl. manifest icons) are already precached via the
      // globPatterns below — don't add them a second time.
      includeManifestIcons: false,
      manifest: {
        name: 'Shoplist — shared shopping lists',
        short_name: 'Shoplist',
        description: 'Shared shopping lists with realtime sync. Invite people with a link or QR code — no accounts needed.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f4f6f3',
        theme_color: '#16a34a',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the whole app shell, including files copied from public/
        // (icons). Stable names like app.js are handled via workbox revision
        // hashes. The generated manifest.webmanifest is
        // added by the plugin itself.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        // Serve the precached shell for offline navigations. The app uses
        // wouter's hash router, so every route resolves to the same index.html.
        navigateFallback: '/index.html',
        // Never answer API requests with the app shell.
        navigateFallbackDenylist: [/^\/api\//],
        // Realtime API stays network-only; the QR endpoint caches well.
        runtimeCaching: [
          {
            urlPattern: /\/api\/qr/,
            handler: 'StaleWhileRevalidate',
            options: { cacheableResponse: { statuses: [200] } },
          },
        ],
        cleanupOutdatedCaches: true,
      },
      // No service worker during development so /api and /ws proxies stay clean.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(root, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: 'app.js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: asset => asset.name?.endsWith('.css') ? 'app.css' : 'assets/[name]-[hash][extname]' },
    },
  },
});
