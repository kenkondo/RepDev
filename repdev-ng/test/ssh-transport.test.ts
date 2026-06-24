import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { SshTransport } from '../src/symitar/transport.js';

/**
 * We can't reach a real AIX SSH host in CI, but we can prove the ssh2-backed
 * transport loads and its connect/error path works: pointing it at a plain TCP
 * server that is not an SSH server must reject (handshake failure), not crash
 * with a module-load error.
 */
describe('SshTransport', () => {
  it('rejects on a refused connection (ssh2 module loads, error path works)', async () => {
    // Grab a port, then close it so the connection is refused immediately.
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));

    await expect(
      SshTransport.connect({ host: '127.0.0.1', port, username: 'x', password: 'y', readyTimeoutMs: 4000 }),
    ).rejects.toBeInstanceOf(Error);
  });
});
