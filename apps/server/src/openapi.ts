import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { transportContract } from '@shoplist/transport-contract';

/** The HTTP prefix where the OpenAPI handler serves the contract. */
export const OPENAPI_SERVER_URL = '/api';
export const OPENAPI_TITLE = 'Shoplist API';
export const OPENAPI_API_VERSION = '1.0.0';

export interface GeneratedOpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers: Array<{ url: string; description?: string }>;
  paths: Record<string, unknown>;
  [key: string]: unknown;
}

let generated: Promise<GeneratedOpenApiDocument> | undefined;

/**
 * Generate the OpenAPI document from the shared transport contract.
 *
 * The document is generated once per process because the contract is static
 * and generation is deterministic: regenerating per request would add latency
 * without changing the output.
 */
export function openApiDocument(): Promise<GeneratedOpenApiDocument> {
  generated ??= generateDocument().catch((error: unknown) => {
    // Do not memoize a transient generation failure.
    generated = undefined;
    throw error;
  });
  return generated;
}

async function generateDocument(): Promise<GeneratedOpenApiDocument> {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  return await generator.generate(transportContract, {
    // The generator emits a 3.1.1 document; the OpenAPI test pins that version
    // so an upgrade to a different document version is visible in review.
    info: {
      title: OPENAPI_TITLE,
      version: OPENAPI_API_VERSION,
      description: [
        'Shoplist exposes the same transport contract through native oRPC at /rpc and OpenAPI at /api.',
        'List revisions fence durable list state, Operation IDs identify participant mutations across retries,',
        'and event-stream cursors only track delivery progress.',
      ].join(' '),
    },
    servers: [{ url: OPENAPI_SERVER_URL, description: 'OpenAPI transport' }],
  }) as GeneratedOpenApiDocument;
}
