import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import sharedConfig from '../../vitest.config.js';

const root = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(sharedConfig, defineConfig({
  resolve: {
    alias: { '@': path.resolve(root, 'src') },
  },
  test: {
    environment: 'jsdom',
    // Keep the native transport's absolute URL away from any developer server.
    environmentOptions: { jsdom: { url: 'http://shoplist.test/' } },
    setupFiles: ['./tests/setup.ts'],
  },
}));
