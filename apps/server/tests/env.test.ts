import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnvironmentFiles } from '../src/env.js';

const VAPID_KEYS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;

const previousEnvironment = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of VAPID_KEYS) {
    const value = previousEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnvironment.clear();
});

describe('server environment loading', () => {
  it('loads the repository-root env file when started from apps/server', async () => {
    for (const key of VAPID_KEYS) {
      previousEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-env-'));
    const serverDirectory = path.join(directory, 'apps', 'server');
    const projectDirectory = directory;
    await writeFile(path.join(directory, '.env'), [
      'VAPID_PUBLIC_KEY=root-public',
      'VAPID_PRIVATE_KEY=root-private',
      'VAPID_SUBJECT=mailto:root@example.com',
    ].join('\n'));

    loadEnvironmentFiles(serverDirectory, serverDirectory, projectDirectory);

    expect(process.env.VAPID_PUBLIC_KEY).toBe('root-public');
    expect(process.env.VAPID_PRIVATE_KEY).toBe('root-private');
    expect(process.env.VAPID_SUBJECT).toBe('mailto:root@example.com');
    await rm(directory, { recursive: true, force: true });
  });
});
