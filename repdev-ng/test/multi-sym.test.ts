import { describe, it, expect, afterEach } from 'vitest';
import { EditorService } from '../src/app/editor-service.js';
import { SocketTransport } from '../src/symitar/transport.js';
import { FileType, SessionError } from '../src/symitar/types.js';
import { MockHost, scriptLogin } from './mock-host.js';

/** Two hosts standing in for two SYMs, each serving a distinct file. */
const A = { aixUsername: 'u', aixPassword: 'p', sym: 100, userID: '1.100' };
const B = { aixUsername: 'u', aixPassword: 'p', sym: 200, userID: '1.200' };

const hosts: MockHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

describe('multi-SYM', () => {
  it('serves files from two concurrent SYM sessions independently', async () => {
    const hostA = await MockHost.start(async (api) => {
      await scriptLogin(api, A);
      await api.waitFor('Action=Retrieve');
      api.sendPayload('FROM SYM 100\n');
      api.sendCmd('File~Done');
    });
    const hostB = await MockHost.start(async (api) => {
      await scriptLogin(api, B);
      await api.waitFor('Action=Retrieve');
      api.sendPayload('FROM SYM 200\n');
      api.sendCmd('File~Done');
    });
    hosts.push(hostA, hostB);

    const svc = new EditorService();
    const ta = await SocketTransport.connect('127.0.0.1', hostA.port);
    const tb = await SocketTransport.connect('127.0.0.1', hostB.port);
    expect(await svc.connect({ server: '127.0.0.1', port: hostA.port, transport: ta, ...A })).toBe(SessionError.NONE);
    expect(await svc.connect({ server: '127.0.0.1', port: hostB.port, transport: tb, ...B })).toBe(SessionError.NONE);

    expect(svc.isConnected(100)).toBe(true);
    expect(svc.isConnected(200)).toBe(true);

    const fromA = await svc.openFile({ sym: 100, name: 'X.RG', type: FileType.REPGEN });
    const fromB = await svc.openFile({ sym: 200, name: 'X.RG', type: FileType.REPGEN });
    expect(fromA).toBe('FROM SYM 100\n');
    expect(fromB).toBe('FROM SYM 200\n');

    await svc.disconnectAll();
    expect(svc.isConnected(100)).toBe(false);
    expect(svc.isConnected(200)).toBe(false);
  });
});
