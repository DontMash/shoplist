import { describe, expect, it } from 'vitest';
import { loadServerEnv } from '../src/env.js';

describe('server environment validation', () => {
  it('validates values supplied by the runtime environment', () => {
    const environment = loadServerEnv({
      PORT: '4321',
      HOST: '127.0.0.1',
      DATA_DIR: '/tmp/shoplist-data',
      PUBLIC_ORIGIN: 'https://shoplist.example',
      BUILD_SHA: 'test-sha',
    });

    expect(environment.PORT).toBe(4321);
    expect(environment.HOST).toBe('127.0.0.1');
    expect(environment.DATA_DIR).toBe('/tmp/shoplist-data');
    expect(environment.PUBLIC_ORIGIN).toBe('https://shoplist.example');
    expect(environment.BUILD_SHA).toBe('test-sha');
  });

  it('applies defaults without reading the process environment', () => {
    const environment = loadServerEnv({});

    expect(environment.PORT).toBe(3000);
    expect(environment.HOST).toBe('0.0.0.0');
    expect(environment.BUILD_SHA).toBe('unknown');
    expect(environment.DATA_DIR).toBeUndefined();
  });
});
