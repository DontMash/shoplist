import { defineConfig, mergeConfig } from 'vitest/config';
import sharedConfig from '../../vitest.config.js';

export default mergeConfig(sharedConfig, defineConfig({
  test: {
    environment: 'node',
  },
}));
