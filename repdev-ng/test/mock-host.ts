/**
 * A mock Symitar host that speaks the RepDev wire protocol over a real TCP
 * socket, so the DirectSymitarSession port can be round-trip tested without a
 * live Episys box.
 *
 * Framing (host -> client): <ESC 0xFE> <body> <0xFC>
 * File payload chunk body wraps content between 0xFD and 0xFE.
 * Acks for PROT uploads are fixed 16-byte blocks (byte[7] == 'N' means NAK).
 */
import net from 'node:net';

const ESC = '\x1b';
const FE = '\xfe';
const FC = '\xfc';
const FD = '\xfd';

export interface ScriptApi {
  /** Resolve once `marker` has been received; consumes everything up to and
   * including it (skips intervening noise like bare CRs). */
  waitFor(marker: string): Promise<void>;
  /** Send a raw latin1 string (no framing). */
  send(raw: string): void;
  /** Frame and send a command body, e.g. "File~Done". */
  sendCmd(body: string): void;
  /** Send a file-payload chunk (content wrapped in 0xFD..0xFE inside a frame). */
  sendPayload(content: string): void;
  /** Send a 16-byte PROT ack; nak=true sets byte[7]='N' to force a resend. */
  sendAck(nak?: boolean): void;
}

export type HostScript = (api: ScriptApi) => Promise<void>;

export class MockHost {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  port = 0;
  /** Captured for assertions: everything the client sent, in order. */
  received = '';

  private constructor(server: net.Server) {
    this.server = server;
  }

  static async start(script: HostScript): Promise<MockHost> {
    let host: MockHost;
    const server = net.createServer((socket) => {
      host.sockets.add(socket);
      socket.on('close', () => host.sockets.delete(socket));
      socket.setEncoding('latin1');
      let inbuf = '';
      let waiter: { marker: string; resolve: () => void } | null = null;

      const tryResolve = () => {
        if (waiter) {
          const idx = inbuf.indexOf(waiter.marker);
          if (idx !== -1) {
            inbuf = inbuf.substring(idx + waiter.marker.length);
            const w = waiter;
            waiter = null;
            w.resolve();
          }
        }
      };

      socket.on('data', (chunk: string) => {
        inbuf += chunk;
        host.received += chunk;
        tryResolve();
      });

      const api: ScriptApi = {
        waitFor: (marker: string) =>
          new Promise<void>((resolve) => {
            waiter = { marker, resolve };
            tryResolve();
          }),
        send: (raw: string) => socket.write(raw, 'latin1'),
        sendCmd: (body: string) => socket.write(ESC + FE + body + FC, 'latin1'),
        sendPayload: (content: string) =>
          socket.write(ESC + FE + FD + content + FE + FC, 'latin1'),
        sendAck: (nak = false) =>
          socket.write(nak ? 'AAAAAAANAAAAAAAA' : 'AAAAAAAAAAAAAAAA', 'latin1'),
      };

      script(api).catch((err) => {
        // Surface script errors loudly during tests.
        // eslint-disable-next-line no-console
        console.error('MockHost script error:', err);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = new MockHost(server);
    host.port = (server.address() as net.AddressInfo).port;
    return host;
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/**
 * Runs the standard login handshake a DirectSymitarSession expects, leaving the
 * session "connected". Call this at the top of a script, then continue with the
 * operation under test.
 */
export async function scriptLogin(
  api: ScriptApi,
  opts: { aixUsername: string; aixPassword: string; sym: number; userID: string },
): Promise<void> {
  await api.waitFor(opts.aixUsername);
  api.send('Password:');
  await api.waitFor(opts.aixPassword);
  api.send('[c');
  await api.waitFor('WINDOWSLEVEL=3');
  api.send('$ ');
  await api.waitFor('sym ' + opts.sym);
  api.sendCmd(`SymLogonDir~Dir=${opts.sym}~Host=10.0.0.1`);
  api.sendCmd('SymLogonRev~HostRev=2024.00');
  api.sendCmd('Input~HelpCode=10025');

  await api.waitFor(opts.userID);
  api.sendCmd('SymLogonOK');
  api.sendCmd('Input~HelpCode=0'); // consumed by first "\r"
  api.sendCmd('Input~HelpCode=0'); // consumed by second "\r"
  api.sendCmd('Misc~BankingDate=06222026');
  api.sendCmd('Misc~ConsoleNumber=5');
}
