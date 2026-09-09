import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('qrcode', () => ({
  default: { toString: vi.fn().mockRejectedValue(new Error('renderer unavailable')) },
}));

import { createApp } from '../src/server.js';

describe('typed infrastructure failures', () => {
  let directory: string | undefined;
  it('does not expose QR renderer details', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'shoplist-rpc-error-'));
    const resources = createApp({ dataFile: path.join(directory, 'db.sqlite') });
    const response = await resources.app.request('http://shoplist.test/rpc/qr/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { data: 'https://shoplist.test' } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ json: { code: 'BAD_REQUEST', message: 'Could not encode data.' } });
    resources.store.close();
  });

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });
});
