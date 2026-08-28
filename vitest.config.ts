/** Shared Vitest policy. App configs only provide their environment-specific setup. */
export const coverageConfig = {
  provider: 'v8',
  reporter: ['text', 'html', 'json-summary'],
  reportsDirectory: './coverage',
  thresholds: {
    lines: 90,
    functions: 90,
    branches: 90,
    statements: 90,
  },
};

export default {
  test: {
    coverage: coverageConfig,
  },
};
