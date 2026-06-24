import { describe, it, expect, afterEach } from 'vitest';
import { registerIpc, type IpcHandlerRegistrar } from '../src/electron/ipc.js';
import { IPC } from '../src/electron/ipc-contract.js';
import { EditorService } from '../src/app/editor-service.js';
import { SocketTransport } from '../src/symitar/transport.js';
import { FileType, SessionError } from '../src/symitar/types.js';
import { MockHost, scriptLogin } from './mock-host.js';

/** Fake ipcMain that records handlers and lets the test invoke them. */
class FakeIpc implements IpcHandlerRegistrar {
  handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  invoke(channel: string, ...args: any[]): unknown {
    const h = this.handlers.get(channel);
    if (!h) throw new Error(`No handler for ${channel}`);
    return h(null, ...args);
  }
}

const LOGIN = { aixUsername: 'aixuser', aixPassword: 'aixpass', sym: 999, userID: '1.999' };

let openHost: MockHost | null = null;
afterEach(async () => {
  if (openHost) await openHost.close();
  openHost = null;
});

describe('IPC wiring', () => {
  it('registers every contract channel', () => {
    const ipc = new FakeIpc();
    registerIpc(ipc, new EditorService());
    for (const channel of Object.values(IPC)) {
      expect(ipc.handlers.has(channel)).toBe(true);
    }
  });

  it('routes connect + openFile through to the service and host', async () => {
    const content = 'PRINT "VIA IPC"\nEND\n';
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=Retrieve');
      api.sendPayload(content);
      api.sendCmd('File~Done');
    });

    const ipc = new FakeIpc();
    registerIpc(ipc, new EditorService());

    // The renderer can't pass a transport, so for the test we connect the
    // socket first and hand it in via the same channel payload shape.
    const transport = await SocketTransport.connect('127.0.0.1', openHost.port);
    const err = await ipc.invoke(IPC.connect, {
      server: '127.0.0.1',
      port: openHost.port,
      transport,
      ...LOGIN,
    });
    expect(err).toBe(SessionError.NONE);

    const data = await ipc.invoke(IPC.openFile, { sym: 999, name: 'X.RG', type: FileType.REPGEN });
    expect(data).toBe(content);

    await ipc.invoke(IPC.disconnect, 999);
  });
});
