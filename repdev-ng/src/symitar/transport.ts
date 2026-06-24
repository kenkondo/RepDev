/**
 * Byte transport for a Symitar host connection.
 *
 * The Java DirectSymitarSession reads the socket one char at a time into a
 * growing string buffer and returns as soon as any marker substring appears
 * (readUntil), and also does fixed-size reads (in.read(buf, 0, 16)). Both are
 * captured here behind an interface so the session logic is testable against a
 * mock host without a real socket.
 *
 * Everything is latin1 ('binary'): bytes map 1:1 to chars 0x00-0xFF so the
 * control bytes used by the protocol (0x07, 0x1b, 0xfc, 0xfd, 0xfe) round-trip
 * unchanged, exactly as Java's default-charset InputStreamReader preserved them
 * for sub-256 values.
 */
import net from 'node:net';
import { Client, type ClientChannel } from 'ssh2';

export interface Transport {
  /** Read until any of the given marker substrings appears; resolves with the
   * accumulated buffer up to and including the first-completing marker. Bytes
   * after that marker remain buffered for the next read. */
  readUntil(...markers: string[]): Promise<string>;
  /** Read exactly n chars (used for the 16-byte PROT acks). */
  read(n: number): Promise<string>;
  /** Write a latin1 string to the host. */
  write(data: string): void;
  /** Close the connection. */
  close(): void;
  /** Optional diagnostic tap: onRecv fires for every received chunk, onSend for
   * every write. Used to trace the login handshake. */
  trace?(onRecv: (data: string) => void, onSend: (data: string) => void): void;
}

export class ConnectionClosedError extends Error {
  constructor(message = 'Connection closed by host') {
    super(message);
    this.name = 'ConnectionClosedError';
  }
}

/**
 * Buffers incoming latin1 data and serves readUntil / read requests. The
 * Symitar protocol is strictly request/response, so at most one read is pending
 * at a time; this class enforces that.
 */
export class ByteBuffer {
  private buffer = '';
  private closed = false;
  /** Optional diagnostic tap, fired for every received chunk. */
  onPush?: (data: string) => void;
  private pending:
    | { kind: 'until'; markers: string[]; resolve: (s: string) => void; reject: (e: Error) => void }
    | { kind: 'exact'; n: number; resolve: (s: string) => void; reject: (e: Error) => void }
    | null = null;

  /** Feed newly received latin1 data. */
  push(data: string): void {
    this.onPush?.(data);
    this.buffer += data;
    this.tryResolve();
  }

  /** Signal the underlying stream closed; fails any pending/future reads. */
  end(err?: Error): void {
    this.closed = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(err ?? new ConnectionClosedError());
    }
  }

  readUntil(markers: string[]): Promise<string> {
    if (this.pending) {
      return Promise.reject(new Error('A read is already pending (protocol is request/response)'));
    }
    return new Promise<string>((resolve, reject) => {
      this.pending = { kind: 'until', markers, resolve, reject };
      this.tryResolve();
    });
  }

  read(n: number): Promise<string> {
    if (this.pending) {
      return Promise.reject(new Error('A read is already pending (protocol is request/response)'));
    }
    return new Promise<string>((resolve, reject) => {
      this.pending = { kind: 'exact', n, resolve, reject };
      this.tryResolve();
    });
  }

  private tryResolve(): void {
    if (!this.pending) return;

    if (this.pending.kind === 'until') {
      // Find the earliest-completing marker: the smallest (index + length).
      let bestEnd = -1;
      for (const marker of this.pending.markers) {
        const idx = this.buffer.indexOf(marker);
        if (idx !== -1) {
          const end = idx + marker.length;
          if (bestEnd === -1 || end < bestEnd) bestEnd = end;
        }
      }
      if (bestEnd !== -1) {
        const out = this.buffer.substring(0, bestEnd);
        this.buffer = this.buffer.substring(bestEnd);
        const p = this.pending;
        this.pending = null;
        p.resolve(out);
        return;
      }
    } else {
      if (this.buffer.length >= this.pending.n) {
        const out = this.buffer.substring(0, this.pending.n);
        this.buffer = this.buffer.substring(this.pending.n);
        const p = this.pending;
        this.pending = null;
        p.resolve(out);
        return;
      }
    }

    if (this.closed) {
      const p = this.pending;
      this.pending = null;
      p.reject(new ConnectionClosedError());
    }
  }
}

/** Transport over a TCP socket (raw telnet path of the Java code). */
export class SocketTransport implements Transport {
  private socket: net.Socket;
  private buf = new ByteBuffer();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.setEncoding('latin1');
    this.socket.on('data', (chunk: string) => this.buf.push(chunk));
    this.socket.on('error', (err) => this.buf.end(err));
    this.socket.on('close', () => this.buf.end());
  }

  static connect(host: string, port: number, timeoutMs = 15000): Promise<SocketTransport> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      socket.setKeepAlive(true);
      const onError = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.once('error', onError);
      socket.setTimeout(timeoutMs, () => onError(new Error('Connection timed out')));
      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.removeListener('error', onError);
        resolve(new SocketTransport(socket));
      });
    });
  }

  readUntil(...markers: string[]): Promise<string> {
    return this.buf.readUntil(markers);
  }

  read(n: number): Promise<string> {
    return this.buf.read(n);
  }

  write(data: string): void {
    this.onSend?.(data);
    this.socket.write(data, 'latin1');
  }

  close(): void {
    this.socket.destroy();
  }

  private onSend?: (data: string) => void;
  trace(onRecv: (data: string) => void, onSend: (data: string) => void): void {
    this.buf.onPush = onRecv;
    this.onSend = onSend;
  }
}

export interface SshConnectOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  readyTimeoutMs?: number;
}

/**
 * Transport over an SSH shell channel (replaces the Java `plink` path). ssh2 is
 * pure-JS; we open an interactive shell with a PTY and treat its byte stream
 * exactly like the telnet socket. A broad, legacy-friendly algorithm set is
 * enabled because Symitar AIX hosts are often old OpenSSH builds.
 */
export class SshTransport implements Transport {
  private conn: Client;
  private channel: ClientChannel;
  private buf = new ByteBuffer();

  private constructor(conn: Client, channel: ClientChannel) {
    this.conn = conn;
    this.channel = channel;
    channel.on('data', (d: Buffer) => this.buf.push(d.toString('latin1')));
    if (channel.stderr) channel.stderr.on('data', (d: Buffer) => this.buf.push(d.toString('latin1')));
    channel.on('close', () => this.buf.end());
    conn.on('error', (err) => this.buf.end(err));
    conn.on('close', () => this.buf.end());
  }

  static connect(opts: SshConnectOptions): Promise<SshTransport> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        try {
          conn.end();
        } catch {
          /* ignore */
        }
        reject(err);
      };

      conn.on('ready', () => {
        // Request a PTY-backed shell; the Symitar protocol expects a terminal.
        conn.shell({ term: 'xterm', cols: 132, rows: 50 }, (err, channel) => {
          if (err) return fail(err);
          settled = true;
          resolve(new SshTransport(conn, channel));
        });
      });
      conn.on('error', (err) => fail(err as Error));

      // AIX OpenSSH usually authenticates via keyboard-interactive (PAM) rather
      // than the plain "password" method. Answer every prompt with the password.
      conn.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
        finish(_prompts.map(() => opts.password));
      });

      conn.connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password,
        tryKeyboard: true, // enable keyboard-interactive fallback for PAM/AIX
        readyTimeout: opts.readyTimeoutMs ?? 20000,
        // Accept any host key (parity with the original, which relied on PuTTY's cache).
        hostVerifier: () => true,
        // Enable legacy algorithms for older AIX SSH servers.
        algorithms: {
          kex: [
            'curve25519-sha256',
            'ecdh-sha2-nistp256',
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group14-sha256',
            'diffie-hellman-group14-sha1',
            'diffie-hellman-group-exchange-sha1',
            'diffie-hellman-group1-sha1',
          ] as never,
          serverHostKey: [
            'ssh-ed25519',
            'ecdsa-sha2-nistp256',
            'rsa-sha2-512',
            'rsa-sha2-256',
            'ssh-rsa',
            'ssh-dss',
          ] as never,
          cipher: [
            'aes128-ctr',
            'aes192-ctr',
            'aes256-ctr',
            'aes128-cbc',
            'aes192-cbc',
            'aes256-cbc',
            '3des-cbc',
          ] as never,
          hmac: ['hmac-sha2-256', 'hmac-sha1', 'hmac-md5'] as never,
        },
      });
    });
  }

  readUntil(...markers: string[]): Promise<string> {
    return this.buf.readUntil(markers);
  }

  read(n: number): Promise<string> {
    return this.buf.read(n);
  }

  write(data: string): void {
    this.onSend?.(data);
    this.channel.write(Buffer.from(data, 'latin1'));
  }

  close(): void {
    try {
      this.conn.end();
    } catch {
      /* ignore */
    }
  }

  private onSend?: (data: string) => void;
  trace(onRecv: (data: string) => void, onSend: (data: string) => void): void {
    this.buf.onPush = onRecv;
    this.onSend = onSend;
  }
}
