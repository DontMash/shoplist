import { expect, it } from 'vitest';
import { listNameSchema } from '../src/lib/schemas';

it('validates without probing dynamic code under a strict CSP', () => {
  const originalFunction = globalThis.Function;
  let probeAttempts = 0;

  Object.defineProperty(globalThis, 'Function', {
    configurable: true,
    value: function CspBlockedFunction() {
      probeAttempts += 1;
      throw new Error('dynamic code is blocked by the CSP');
    },
  });

  try {
    expect(listNameSchema.safeParse({ value: 'Weekly groceries' }).success).toBe(true);
    expect(probeAttempts).toBe(0);
  } finally {
    Object.defineProperty(globalThis, 'Function', {
      configurable: true,
      value: originalFunction,
    });
  }
});
