import { describe, it, expect, afterEach } from 'vitest';
import { DirectSymitarSession } from '../src/symitar/session.js';
import { SocketTransport } from '../src/symitar/transport.js';
import { FileType, SessionError, ErrorCheckType } from '../src/symitar/types.js';
import { MockHost, scriptLogin, type ScriptApi } from './mock-host.js';

const LOGIN = { aixUsername: 'aixuser', aixPassword: 'aixpass', sym: 999, userID: '1.999' };

async function connect(host: MockHost): Promise<DirectSymitarSession> {
  const transport = await SocketTransport.connect('127.0.0.1', host.port);
  const session = new DirectSymitarSession();
  const err = await session.connect({
    server: '127.0.0.1',
    port: host.port,
    transport,
    ...LOGIN,
  });
  expect(err).toBe(SessionError.NONE);
  return session;
}

let openHost: MockHost | null = null;
afterEach(async () => {
  if (openHost) await openHost.close();
  openHost = null;
});

describe('DirectSymitarSession round-trips against a mock host', () => {
  it('connects and logs in, capturing sym/console metadata', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
    });
    const session = await connect(openHost);
    expect(session.isConnected()).toBe(true);
    expect(session.actualSym).toBe(999);
    expect(session.consoleNum).toBe(5);
    expect(session.symRev).toBe('2024.00');
    await session.disconnect();
  });

  it('rejects a wrong AIX password', async () => {
    openHost = await MockHost.start(async (api) => {
      await api.waitFor(LOGIN.aixUsername);
      api.send('Password:');
      await api.waitFor(LOGIN.aixPassword);
      api.send('invalid login name or password');
    });
    const transport = await SocketTransport.connect('127.0.0.1', openHost.port);
    const session = new DirectSymitarSession();
    const err = await session.connect({ server: '127.0.0.1', port: openHost.port, transport, ...LOGIN });
    expect(err).toBe(SessionError.AIX_LOGIN_WRONG);
    expect(session.isConnected()).toBe(false);
  });

  it('retrieves a RepGen file (payload framed in 0xFD..0xFE)', async () => {
    const content = 'PRINT TITLE "HELLO"\nEND\n';
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=Retrieve');
      api.sendPayload(content);
      api.sendCmd('File~Done');
    });
    const session = await connect(openHost);
    const data = await session.getFile({ sym: 999, name: 'TEST.RG', type: FileType.REPGEN });
    expect(data).toBe(content);
    await session.disconnect();
  });

  it('returns empty string for a missing file', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=Retrieve');
      api.sendCmd('File~Status=No such file or directory');
    });
    const session = await connect(openHost);
    const data = await session.getFile({ sym: 999, name: 'NOPE.RG', type: FileType.REPGEN });
    expect(data).toBe('');
    await session.disconnect();
  });

  it('saves a file with the chunked PROT upload', async () => {
    const text = 'Hello World';
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=Store');
      api.sendCmd('File~BadCharList=');
      await api.waitFor('PROT000DATA');
      api.sendAck();
      await api.waitFor('EOF');
      api.sendAck();
      api.sendCmd('File~Done');
    });
    const session = await connect(openHost);
    const err = await session.saveFile({ sym: 999, name: 'TEST.RG', type: FileType.REPGEN }, text);
    expect(err).toBe(SessionError.NONE);
    // The actual file bytes reached the host.
    expect(openHost.received).toContain('Hello World');
    await session.disconnect();
  });

  it('resends a chunk after a NAK', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=Store');
      api.sendCmd('File~BadCharList=');
      await api.waitFor('PROT000DATA');
      api.sendAck(true); // NAK -> client must resend
      await api.waitFor('PROT000DATA');
      api.sendAck(false);
      await api.waitFor('EOF');
      api.sendAck();
      api.sendCmd('File~Done');
    });
    const session = await connect(openHost);
    const err = await session.saveFile({ sym: 999, name: 'TEST.RG', type: FileType.REPGEN }, 'data');
    expect(err).toBe(SessionError.NONE);
    await session.disconnect();
  });

  it('reports FILE_READ_ONLY when the host refuses the store', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=Store');
      api.sendCmd('File~BadCharList=');
      await api.waitFor('PROT000DATA');
      api.sendAck();
      await api.waitFor('EOF');
      api.sendAck();
      api.sendCmd('File~Status=Unable to save on Output Open');
    });
    const session = await connect(openHost);
    const err = await session.saveFile({ sym: 999, name: 'RO.RG', type: FileType.REPGEN }, 'x');
    expect(err).toBe(SessionError.FILE_READ_ONLY);
    await session.disconnect();
  });

  it('error-checks a clean RepGen (NO_ERROR)', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('mm3');
      api.sendCmd('Input');
      await api.waitFor('7');
      api.sendCmd('Misc~Filler=1');
      api.sendCmd('Misc~Filler=2');
      await api.waitFor('CLEAN.RG');
      api.sendCmd('SpecfileErr~Action=NoError');
      api.sendCmd('SpecfileErr~Action=Done');
    });
    const session = await connect(openHost);
    const res = await session.errorCheckRepGen('CLEAN.RG');
    expect(res?.type).toBe(ErrorCheckType.NO_ERROR);
    await session.disconnect();
  });

  it('error-checks a broken RepGen and reports line/col/message', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('mm3');
      api.sendCmd('Input');
      await api.waitFor('7');
      api.sendCmd('Misc~Filler=1');
      api.sendCmd('Misc~Filler=2');
      await api.waitFor('BROKEN.RG');
      api.sendCmd('SpecfileErr~Action=Init~FileName=BROKEN.RG');
      api.sendCmd('SpecfileErr~Action=FileInfo~Line=12~Col=5');
      api.sendCmd('SpecfileErr~Action=ErrText~Line=Undefined identifier FOO');
      api.sendCmd('SpecfileErr~Action=DisplayEdit');
      api.sendCmd('SpecfileErr~Action=Done');
    });
    const session = await connect(openHost);
    const res = await session.errorCheckRepGen('BROKEN.RG');
    expect(res?.type).toBe(ErrorCheckType.ERROR);
    expect(res?.file).toBe('BROKEN.RG');
    expect(res?.lineNumber).toBe(12);
    expect(res?.column).toBe(5);
    expect(res?.errorMessage).toBe('Undefined identifier FOO');
    await session.disconnect();
  });

  it('lists files (used by fileExists)', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=List');
      api.sendCmd('File~Name=TEST.RG');
      api.sendCmd('File~Name=TEST2.RG');
      api.sendCmd('File~Done');
    });
    const session = await connect(openHost);
    const list = await session.getFileList(FileType.REPGEN, 'TEST');
    expect(list.map((f) => f.name)).toEqual(['TEST.RG', 'TEST2.RG']);
    await session.disconnect();
  });
});
