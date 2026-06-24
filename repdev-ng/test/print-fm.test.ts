import { describe, it, expect, afterEach } from 'vitest';
import { DirectSymitarSession } from '../src/symitar/session.js';
import { SocketTransport } from '../src/symitar/transport.js';
import { FMFile, FileType, SessionError, comparePrintItems, parseSymitarDate } from '../src/symitar/types.js';
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

describe('print/FM pure helpers', () => {
  it('parses date with and without time', () => {
    expect(parseSymitarDate('06222026')).toEqual(new Date(2026, 5, 22, 0, 0));
    expect(parseSymitarDate('06222026', '1030')).toEqual(new Date(2026, 5, 22, 10, 30));
    expect(parseSymitarDate('bad')).toBeNull();
  });

  it('orders print items by batchSeq within a day', () => {
    const d = new Date(2026, 5, 22);
    const a = { title: 'a', seq: 1, size: 0, pages: 0, batchSeq: 20, date: d };
    const b = { title: 'b', seq: 2, size: 0, pages: 0, batchSeq: 10, date: d };
    expect([a, b].sort(comparePrintItems).map((x) => x.batchSeq)).toEqual([10, 20]);
  });
});

describe('getPrintItems', () => {
  it('lists report items newest-first and parses fields', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=List');
      api.sendCmd('File~Sequence=100~Title=NIGHTLY~Size=500~PageCount=2~BatchSeq=10~Date=06222026~Time=1030');
      api.sendCmd('File~Sequence=101~Title=DAILY~Size=300~PageCount=1~BatchSeq=11~Date=06222026~Time=1145');
      api.sendCmd('File~Done');
    });
    const s = await connect(openHost);
    const items = await s.getPrintItems('REPWRITER', 10);
    expect(items.map((i) => i.batchSeq)).toEqual([10, 11]);
    expect(items[0].title).toBe('NIGHTLY');
    expect(items[0].pages).toBe(2);
    await s.disconnect();
  });
});

describe('isSeqRunning', () => {
  it('detects a running batch sequence', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('BatchQueues');
      api.sendCmd('Misc~Action=QueueEntry~Seq=555~Stat=Running');
      api.sendCmd('Misc~Done');
    });
    const s = await connect(openHost);
    expect(await s.isSeqRunning(555)).toBe(true);
    await s.disconnect();
  });
});

describe('printFileLPT', () => {
  it('rejects non-report files', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
    });
    const s = await connect(openHost);
    const err = await s.printFileLPT({ sym: 999, name: 'X.RG', type: FileType.REPGEN }, 2);
    expect(err).toBe(SessionError.INVALID_FILE_TYPE);
    await s.disconnect();
  });

  it('drives the LPT print dialog to completion', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('mm1');
      api.sendCmd('Input');
      await api.waitFor('P\r');
      api.sendCmd('Input');
      await api.waitFor('99999\r');
      api.sendCmd('Input');
      await api.waitFor('\r'); // blank line after name
      api.sendCmd('Input~HelpCode=10008'); // queue prompt
      await api.waitFor('2\r'); // queue
      api.sendCmd('Input');
      await api.waitFor('\r'); // blank
      api.sendCmd('Input'); // no banner prompt
      await api.waitFor('0\r'); // formsOverride=0
      api.sendCmd('Input');
      await api.waitFor('0\r'); // startPage
      api.sendCmd('Input');
      await api.waitFor('0\r'); // endPage
      api.sendCmd('Input');
      await api.waitFor('1\r'); // copies=1
      api.sendCmd('Input');
      await api.waitFor('0\r'); // landscape=0
      api.sendCmd('Input');
      await api.waitFor('0\r'); // duplex=0
      api.sendCmd('Input');
      await api.waitFor('4\r'); // confirm
      api.sendCmd('Input');
    });
    const s = await connect(openHost);
    const err = await s.printFileLPT({ sym: 999, name: '99999', type: FileType.REPORT }, 2);
    expect(err).toBe(SessionError.NONE);
    await s.disconnect();
  });

  it('returns INVALID_QUEUE on a host error dialog', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('mm1');
      api.sendCmd('Input');
      await api.waitFor('P\r');
      api.sendCmd('Input');
      await api.waitFor('99999\r');
      api.sendCmd('Input');
      await api.waitFor('\r');
      api.sendCmd('Input~HelpCode=10008');
      await api.waitFor('7\r'); // bad queue
      api.sendCmd('MsgDlg~Type=Error');
    });
    const s = await connect(openHost);
    const err = await s.printFileLPT({ sym: 999, name: '99999', type: FileType.REPORT }, 7);
    expect(err).toBe(SessionError.INVALID_QUEUE);
    await s.disconnect();
  });
});

async function fmDrain(api: ScriptApi, marker: string): Promise<void> {
  await api.waitFor(marker);
  api.sendCmd('Input');
}

describe('runBatchFM', () => {
  it('queues a batch FM and returns the sequence', async () => {
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await fmDrain(api, 'mm0');
      await fmDrain(api, '1\r');
      await fmDrain(api, '24\r');
      await fmDrain(api, '5\r');
      await fmDrain(api, '2\r'); // FMFile.PAYEE ordinal
      await fmDrain(api, '0\r'); // undo posting?
      await fmDrain(api, 'MYSEARCH\r');
      await fmDrain(api, '30\r'); // search days
      await fmDrain(api, 'FMTEST\r'); // result title
      await fmDrain(api, '1\r'); // produce empty report (no 25514 follow-up)
      // batch options -> queue list
      await api.waitFor('0\r');
      api.sendCmd('Foo~Action=DisplayLine~Text=Batch Queues Available: 0, 1');
      api.sendCmd('Input');
      // first BatchQueues -> counts
      await api.waitFor('BatchQueues');
      api.sendCmd('Misc~Action=QueueEmpty~Queue=0');
      api.sendCmd('Misc~Action=QueueEntry~Stat=Running~Queue=1');
      api.sendCmd('Misc~Done');
      await fmDrain(api, '0\r'); // chosen queue 0
      await fmDrain(api, '1\r'); // confirm
      // second BatchQueues -> seq
      await api.waitFor('BatchQueues');
      api.sendCmd('Misc~Action=QueueEntry~Seq=7777~Time=11:22:33');
      api.sendCmd('Misc~Done');
    });
    const s = await connect(openHost);
    const res = await s.runBatchFM('MYSEARCH', 30, FMFile.PAYEE, -1, 'FMTEST');
    expect(res.resultTitle).toBe('FMTEST');
    expect(res.seq).toBe(7777);
    await s.disconnect();
  });
});

describe('getReportSeqs', () => {
  it('matches a REPWRITER report by name and returns its batch sequence', async () => {
    const report =
      'Report\nProcessing begun on' + 'X'.repeat(22) + '10:30:45 etc\n(newline when done): NIGHTLY\nbody';
    openHost = await MockHost.start(async (api) => {
      await scriptLogin(api, LOGIN);
      await api.waitFor('Action=List'); // getPrintItems('REPWRITER', ...)
      api.sendCmd('File~Sequence=200~Title=X~Size=1~PageCount=1~BatchSeq=88~Date=06222026~Time=1030');
      api.sendCmd('File~Done');
      await api.waitFor('Action=Retrieve'); // getFile(REPORT, '200')
      api.sendPayload(report);
      api.sendCmd('File~Done');
    });
    const s = await connect(openHost);
    const seqs = await s.getReportSeqs('NIGHTLY', -1, 100, 5);
    expect(seqs).toHaveLength(1);
    expect(seqs[0].seq).toBe(88);
    await s.disconnect();
  });
});
