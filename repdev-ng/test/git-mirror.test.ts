import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitMirror, buildCommitMessage } from '../src/git/git-mirror.js';
import { EditorService } from '../src/app/editor-service.js';
import { DirectSymitarSession } from '../src/symitar/session.js';
import { SocketTransport } from '../src/symitar/transport.js';
import { FileType, SessionError } from '../src/symitar/types.js';
import { MockHost, scriptLogin, type ScriptApi } from './mock-host.js';

const REPGEN = (name: string) => ({ sym: 999, name, type: FileType.REPGEN });

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'repdev-mirror-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('GitMirror against a real git repo', () => {
  it('initialises a repo and commits a clean save with the NO_ERROR verdict', async () => {
    const mirror = new GitMirror(tmp);
    await mirror.init();
    const hash = await mirror.commitSave(REPGEN('A.RG'), 'PRINT "HI"\nEND\n', {
      error: SessionError.NONE,
      diagnostics: [],
      clean: true,
    });
    expect(hash).toBeTruthy();
    expect(await mirror.lastCommitted(REPGEN('A.RG'))).toBe('PRINT "HI"\nEND\n');
    const history = await mirror.history(REPGEN('A.RG'));
    expect(history).toHaveLength(1);
    expect(history[0].message).toContain('Compile: NO_ERROR');
  });

  it('records an erroring save with the compile error in the message', async () => {
    const mirror = new GitMirror(tmp);
    await mirror.init();
    await mirror.commitSave(REPGEN('BAD.RG'), 'PRINT', {
      error: SessionError.NONE,
      diagnostics: [{ line: 7, column: 3, message: 'Expected END', severity: 'error' }],
      clean: false,
    });
    const [latest] = await mirror.history(REPGEN('BAD.RG'));
    expect(latest.message).toContain('ERROR line 7 col 3: Expected END');
  });

  it('skips an unchanged save (nothing to commit) but commits real changes', async () => {
    const mirror = new GitMirror(tmp);
    await mirror.init();
    const result = { error: SessionError.NONE, diagnostics: [], clean: true };

    const first = await mirror.commitSave(REPGEN('A.RG'), 'v1\n', result);
    const same = await mirror.commitSave(REPGEN('A.RG'), 'v1\n', result);
    const changed = await mirror.commitSave(REPGEN('A.RG'), 'v2\n', result);

    expect(first).toBeTruthy();
    expect(same).toBeNull(); // identical content => no commit
    expect(changed).toBeTruthy();
    expect((await mirror.history(REPGEN('A.RG'))).length).toBe(2);
  });

  it('diffAgainstHost surfaces committed vs live host content', async () => {
    const mirror = new GitMirror(tmp);
    await mirror.init();
    await mirror.commitSave(REPGEN('A.RG'), 'committed\n', {
      error: SessionError.NONE,
      diagnostics: [],
      clean: true,
    });
    const diff = await mirror.diffAgainstHost(REPGEN('A.RG'), 'host-now\n');
    expect(diff.committed).toBe('committed\n');
    expect(diff.host).toBe('host-now\n');
  });

  it('buildCommitMessage formats each verdict kind', () => {
    expect(
      buildCommitMessage(REPGEN('X.RG'), { error: SessionError.NONE, diagnostics: [], clean: true }, 'me'),
    ).toContain('Compile: NO_ERROR');
    expect(
      buildCommitMessage(
        REPGEN('X.RG'),
        { error: SessionError.FILE_READ_ONLY, diagnostics: [], clean: false },
        'me',
      ),
    ).toContain('SAVE FAILED (FILE_READ_ONLY)');
  });
});

const LOGIN = { aixUsername: 'aixuser', aixPassword: 'aixpass', sym: 999, userID: '1.999' };

async function scriptStore(api: ScriptApi): Promise<void> {
  await api.waitFor('Action=Store');
  api.sendCmd('File~BadCharList=');
  await api.waitFor('PROT000DATA');
  api.sendAck();
  await api.waitFor('EOF');
  api.sendAck();
  api.sendCmd('File~Done');
}

describe('EditorService + GitMirror end-to-end', () => {
  let host: MockHost | null = null;
  afterEach(async () => {
    if (host) await host.close();
    host = null;
  });

  it('a clean save through the service lands a commit in the mirror', async () => {
    host = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await scriptStore(api);
      // error-check preamble + NoError
      await api.waitFor('mm3');
      api.sendCmd('Input');
      await api.waitFor('7');
      api.sendCmd('Misc~F=1');
      api.sendCmd('Misc~F=2');
      await api.waitFor('CLEAN.RG');
      api.sendCmd('SpecfileErr~Action=NoError');
      api.sendCmd('SpecfileErr~Action=Done');
    });

    const mirror = new GitMirror(tmp);
    await mirror.init();
    const svc = new EditorService(() => new DirectSymitarSession(), mirror);

    const transport = await SocketTransport.connect('127.0.0.1', host.port);
    expect(await svc.connect({ server: '127.0.0.1', port: host.port, transport, ...LOGIN })).toBe(
      SessionError.NONE,
    );

    const res = await svc.saveFile(REPGEN('CLEAN.RG'), 'PRINT "OK"\nEND\n');
    expect(res.error).toBe(SessionError.NONE);
    expect(res.clean).toBe(true);
    expect(res.commit).toBeTruthy();
    expect(await mirror.lastCommitted(REPGEN('CLEAN.RG'))).toBe('PRINT "OK"\nEND\n');

    await svc.disconnectAll();
  });

  it('a save+install commits with the INSTALLED verdict and size', async () => {
    host = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await scriptStore(api);
      // install choreography (menu option 8)
      await api.waitFor('mm3');
      api.sendCmd('Input');
      await api.waitFor('8\r');
      api.sendCmd('Misc~R=1');
      api.sendCmd('Misc~R=2');
      await api.waitFor('LIVE.RG\r');
      api.sendCmd('SpecfileData~Size=9,001');
      api.sendCmd('Misc~Prompt=1');
      await api.waitFor('1\r');
      api.sendCmd('Misc~Done=1');
      api.sendCmd('Misc~Done=2');
    });

    const mirror = new GitMirror(tmp);
    await mirror.init();
    const svc = new EditorService(() => new DirectSymitarSession(), mirror);
    const transport = await SocketTransport.connect('127.0.0.1', host.port);
    await svc.connect({ server: '127.0.0.1', port: host.port, transport, ...LOGIN });

    const res = await svc.saveFile(REPGEN('LIVE.RG'), 'PRINT "LIVE"\nEND\n', 'install');
    expect(res.installed).toBe(true);
    expect(res.installSize).toBe(9001);
    expect(res.commit).toBeTruthy();

    const [latest] = await mirror.history(REPGEN('LIVE.RG'));
    expect(latest.message).toContain('Compile: INSTALLED (size 9001)');

    await svc.disconnectAll();
  });

  it('service.diff returns committed (Git) vs live host content', async () => {
    host = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      // host now returns a *newer* version than what's committed
      await api.waitFor('Action=Retrieve');
      api.sendPayload('PRINT "HOST EDIT"\nEND\n');
      api.sendCmd('File~Done');
    });

    const mirror = new GitMirror(tmp);
    await mirror.init();
    await mirror.commitSave(REPGEN('D.RG'), 'PRINT "OLD"\nEND\n', {
      error: SessionError.NONE,
      diagnostics: [],
      clean: true,
    });

    const svc = new EditorService(() => new DirectSymitarSession(), mirror);
    const transport = await SocketTransport.connect('127.0.0.1', host.port);
    await svc.connect({ server: '127.0.0.1', port: host.port, transport, ...LOGIN });

    const diff = await svc.diff(REPGEN('D.RG'));
    expect(diff?.committed).toBe('PRINT "OLD"\nEND\n');
    expect(diff?.host).toBe('PRINT "HOST EDIT"\nEND\n');

    await svc.disconnectAll();
  });
});
