import { describe, it, expect, afterEach } from 'vitest';
import { DirectSymitarSession } from '../src/symitar/session.js';
import { SocketTransport } from '../src/symitar/transport.js';
import { ErrorCheckType, FileType, SessionError } from '../src/symitar/types.js';
import { MockHost, scriptLogin, type ScriptApi } from './mock-host.js';

const LOGIN = { aixUsername: 'aixuser', aixPassword: 'aixpass', sym: 999, userID: '1.999' };

async function connect(host: MockHost): Promise<DirectSymitarSession> {
  const transport = await SocketTransport.connect('127.0.0.1', host.port);
  const session = new DirectSymitarSession();
  expect(await session.connect({ server: '127.0.0.1', port: host.port, transport, ...LOGIN })).toBe(
    SessionError.NONE,
  );
  return session;
}

let openHost: MockHost | null = null;
afterEach(async () => {
  if (openHost) await openHost.close();
  openHost = null;
});

const RG = (name: string) => ({ sym: 999, name, type: FileType.REPGEN });

describe('removeFile / renameFile', () => {
  it('removes a file (Done)', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=Delete');
      api.sendCmd('File~Done');
    });
    const s = await connect(openHost);
    expect(await s.removeFile(RG('OLD.RG'))).toBe(SessionError.NONE);
    await s.disconnect();
  });

  it('reports ARGUMENT_ERROR removing a missing file', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=Delete');
      api.sendCmd('File~Status=No such file or directory');
    });
    const s = await connect(openHost);
    expect(await s.removeFile(RG('GONE.RG'))).toBe(SessionError.ARGUMENT_ERROR);
    await s.disconnect();
  });

  it('renames a file (Done)', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('NewName=NEW.RG');
      api.sendCmd('File~Done');
    });
    const s = await connect(openHost);
    expect(await s.renameFile(RG('OLD.RG'), 'NEW.RG')).toBe(SessionError.NONE);
    await s.disconnect();
  });
});

async function runPreamble(api: ScriptApi, name: string): Promise<void> {
  await api.waitFor('mm0');
  api.sendCmd('Input');
  await api.waitFor('1\r');
  api.sendCmd('Input');
  await api.waitFor('11\r');
  api.sendCmd('Input');
  await api.waitFor(name + '\r');
}

async function installPreamble(api: ScriptApi, name: string): Promise<void> {
  await api.waitFor('mm3');
  api.sendCmd('Input');
  await api.waitFor('8\r'); // menu option 8 = compile + install
  api.sendCmd('Misc~R=1');
  api.sendCmd('Misc~R=2');
  await api.waitFor(name + '\r');
}

describe('installRepgen (compile + install)', () => {
  it('installs a clean RepGen and reports INSTALLED_SUCCESSFULLY with size', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await installPreamble(api, 'CLEAN.RG');
      api.sendCmd('SpecfileData~Size=14,820');
      api.sendCmd('Misc~Prompt=1'); // drained before answering
      await api.waitFor('1\r'); // confirm install
      api.sendCmd('Misc~Done=1');
      api.sendCmd('Misc~Done=2');
    });
    const s = await connect(openHost);
    const res = await s.installRepgen('CLEAN.RG');
    expect(res?.type).toBe(ErrorCheckType.INSTALLED_SUCCESSFULLY);
    expect(res?.installSize).toBe(14820);
    await s.disconnect();
  });

  it('reports compile errors with line/col/message instead of installing', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await installPreamble(api, 'BAD.RG');
      api.sendCmd('SpecfileErr~Action=Init~FileName=BAD.RG');
      api.sendCmd('SpecfileErr~Action=FileInfo~Line=42~Col=8');
      api.sendCmd('SpecfileErr~Action=ErrText~Line=Undefined identifier WIDGET');
      api.sendCmd('SpecfileErr~Action=DisplayEdit');
      api.sendCmd('SpecfileErr~Action=Done');
    });
    const s = await connect(openHost);
    const res = await s.installRepgen('BAD.RG');
    expect(res?.type).toBe(ErrorCheckType.ERROR);
    expect(res?.lineNumber).toBe(42);
    expect(res?.column).toBe(8);
    expect(res?.errorMessage).toBe('Undefined identifier WIDGET');
    await s.disconnect();
  });
});

describe('runRepGen', () => {
  it('cancels when the prompter returns null', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await runPreamble(api, 'RPT');
      api.sendCmd('Input~HelpCode=100~Prompt=Enter Date');
      await api.waitFor('\x1b'); // ESC = cancel
      api.sendCmd('Input');
    });
    const s = await connect(openHost);
    const res = await s.runRepGen('RPT', -1, { prompter: () => null });
    expect(res.seq).toBe(-1);
    await s.disconnect();
  });

  it('returns -1 when the repgen does not exist on the host', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await runPreamble(api, 'MISSING');
      api.sendCmd('Batch~Action=DisplayLine~Text=No such file or directory');
      api.sendCmd('Input');
    });
    const s = await connect(openHost);
    const res = await s.runRepGen('MISSING', -1, {});
    expect(res.seq).toBe(-1);
    await s.disconnect();
  });

  it('queues a run with no prompts and returns the batch sequence', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await runPreamble(api, 'RPT');
      api.sendCmd('Input~HelpCode=20301'); // run confirmation
      await api.waitFor('\r');
      api.sendCmd('Input');
      await api.waitFor('0\r'); // menu option 0
      api.sendCmd('Batch~Action=DisplayLine~Text=Batch Queues Available: 0, 1, 3-5');
      api.sendCmd('Input');
      // first BatchQueues query -> counts
      await api.waitFor('BatchQueues');
      api.sendCmd('Misc~Action=QueueEmpty~Queue=0');
      api.sendCmd('Misc~Action=QueueEntry~Stat=Running~Queue=1');
      api.sendCmd('Misc~Done');
      await api.waitFor('0\r'); // chosen queue 0
      api.sendCmd('Input');
      await api.waitFor('1\r');
      api.sendCmd('Input');
      // second BatchQueues query -> seq/time
      await api.waitFor('BatchQueues');
      api.sendCmd('Misc~Action=QueueEntry~Stat=Running~Seq=12345~Time=10:30:45');
      api.sendCmd('Misc~Done');
    });
    const s = await connect(openHost);
    const progress: number[] = [];
    const res = await s.runRepGen('RPT', -1, { onProgress: (p) => progress.push(p) });
    expect(res.seq).toBe(12345);
    expect(res.time).toBe(10 * 3600 + 30 * 60 + 45);
    expect(progress).toContain(50);
    await s.disconnect();
  });
});
