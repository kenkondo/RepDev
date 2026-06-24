import { describe, it, expect, afterEach } from 'vitest';
import { EditorService } from '../src/app/editor-service.js';
import { SocketTransport } from '../src/symitar/transport.js';
import { FileType, SessionError } from '../src/symitar/types.js';
import { MockHost, scriptLogin, type ScriptApi } from './mock-host.js';

const LOGIN = { aixUsername: 'aixuser', aixPassword: 'aixpass', sym: 999, userID: '1.999' };

async function connected(host: MockHost): Promise<EditorService> {
  const transport = await SocketTransport.connect('127.0.0.1', host.port);
  const svc = new EditorService();
  const err = await svc.connect({ server: '127.0.0.1', port: host.port, transport, ...LOGIN });
  expect(err).toBe(SessionError.NONE);
  return svc;
}

async function scriptStore(api: ScriptApi): Promise<void> {
  await api.waitFor('Action=Store');
  api.sendCmd('File~BadCharList=');
  await api.waitFor('PROT000DATA');
  api.sendAck();
  await api.waitFor('EOF');
  api.sendAck();
  api.sendCmd('File~Done');
}

async function scriptErrorCheckPreamble(api: ScriptApi, name: string): Promise<void> {
  await api.waitFor('mm3');
  api.sendCmd('Input');
  await api.waitFor('7');
  api.sendCmd('Misc~Filler=1');
  api.sendCmd('Misc~Filler=2');
  await api.waitFor(name);
}

let openHost: MockHost | null = null;
afterEach(async () => {
  if (openHost) await openHost.close();
  openHost = null;
});

describe('EditorService end-to-end (open/save/diagnostics)', () => {
  it('opens a file through the service', async () => {
    const content = 'PRINT "HI"\nEND\n';
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=Retrieve');
      api.sendPayload(content);
      api.sendCmd('File~Done');
    });
    const svc = await connected(openHost);
    const data = await svc.openFile({ sym: 999, name: 'A.RG', type: FileType.REPGEN });
    expect(data).toBe(content);
    await svc.disconnectAll();
  });

  it('saves a clean RepGen: no diagnostics, clean=true (commit signal)', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await scriptStore(api);
      await scriptErrorCheckPreamble(api, 'CLEAN.RG');
      api.sendCmd('SpecfileErr~Action=NoError');
      api.sendCmd('SpecfileErr~Action=Done');
    });
    const svc = await connected(openHost);
    const res = await svc.saveFile({ sym: 999, name: 'CLEAN.RG', type: FileType.REPGEN }, 'END');
    expect(res.error).toBe(SessionError.NONE);
    expect(res.diagnostics).toEqual([]);
    expect(res.clean).toBe(true);
    await svc.disconnectAll();
  });

  it('saves a broken RepGen: surfaces a diagnostic, clean=false', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await scriptStore(api);
      await scriptErrorCheckPreamble(api, 'BAD.RG');
      api.sendCmd('SpecfileErr~Action=Init~FileName=BAD.RG');
      api.sendCmd('SpecfileErr~Action=FileInfo~Line=7~Col=3');
      api.sendCmd('SpecfileErr~Action=ErrText~Line=Expected END');
      api.sendCmd('SpecfileErr~Action=DisplayEdit');
      api.sendCmd('SpecfileErr~Action=Done');
    });
    const svc = await connected(openHost);
    const res = await svc.saveFile({ sym: 999, name: 'BAD.RG', type: FileType.REPGEN }, 'PRINT');
    expect(res.error).toBe(SessionError.NONE);
    expect(res.clean).toBe(false);
    expect(res.diagnostics).toEqual([
      { line: 7, column: 3, message: 'Expected END', severity: 'error' },
    ]);
    await svc.disconnectAll();
  });

  it('refuses a second connect to an already-connected SYM', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
    });
    const svc = await connected(openHost);
    const transport = await SocketTransport.connect('127.0.0.1', openHost.port);
    const err = await svc.connect({ server: '127.0.0.1', port: openHost.port, transport, ...LOGIN });
    expect(err).toBe(SessionError.ALREADY_CONNECTED);
    transport.close(); // the rejected connect never adopted this socket
    await svc.disconnectAll();
  });
});
