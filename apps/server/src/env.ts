import { config as loadDotenv } from 'dotenv';
import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

// Load local development values before t3-env validates the runtime source.
// Container and CI environments continue to provide their values directly.
loadDotenv();

/**
 * Read and validate the server environment at the point an application is
 * created. Reading lazily keeps tests and embedders able to provide an
 * isolated process environment without reloading this module.
 */
export function loadServerEnv(runtimeEnv: NodeJS.ProcessEnv = process.env) {
  return createEnv({
    server: {
      PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
      HOST: z.string().min(1).default('0.0.0.0'),
      DATA_DIR: z.string().min(1).optional(),
      PUBLIC_DIR: z.string().min(1).optional(),
      PUBLIC_ORIGIN: z.string().url().optional(),
      VAPID_PUBLIC_KEY: z.string().min(1).optional(),
      VAPID_PRIVATE_KEY: z.string().min(1).optional(),
      VAPID_SUBJECT: z.string().min(1).optional(),
      BUILD_SHA: z.string().default('unknown'),
    },
    // Pass a copy because emptyStringAsUndefined intentionally removes empty
    // values and process.env is shared with the rest of the Node process.
    runtimeEnv: { ...runtimeEnv },
    emptyStringAsUndefined: true,
  });
}

export type ServerEnv = ReturnType<typeof loadServerEnv>;
