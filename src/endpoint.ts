import { createServer } from 'node:net';

/**
 * Ask the extension-host OS for a loopback port, then release it immediately.
 * This is used only when Remote forwarding needs a concrete port before DSH
 * starts so its exact forwarded authority can enter the Host allow-list.
 */
export function findAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Could not allocate a listening port for DeepSeek Harness'));
        else resolve(port);
      });
    });
  });
}
