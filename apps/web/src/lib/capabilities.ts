/**
 * The UI is an AppPort client: it calls the same capability MCP exposes, through the same
 * HTTP binding and authorization pipeline. There is no separate REST listing operation.
 */
import { createClient, type AppPortClient } from '@appport/client';
import { createHttpTransport } from '@appport/transport-http';

let clientPromise: Promise<AppPortClient> | undefined;

function client(): Promise<AppPortClient> {
  clientPromise ??= (async () => {
    const instance = createClient({
      transport: createHttpTransport({ url: '/appport', credentials: 'same-origin' }),
    });
    await instance.connect();
    await instance.load();
    return instance;
  })().catch((error: unknown) => {
    clientPromise = undefined;
    throw error;
  });
  return clientPromise;
}

export async function callCapability<Output>(name: string, input: unknown): Promise<Output> {
  const instance = await client();
  return instance.call<Output>(name, input);
}
