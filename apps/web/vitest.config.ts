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
    setupFiles: ['./tests/setup.ts'],
  },
}));
