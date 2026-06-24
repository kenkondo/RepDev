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
  private pending:
    | { kind: 'until'; markers: string[]; resolve: (s: string) => void; reject: (e: Error) => void }
    | { kind: 'exact'; n: number; resolve: (s: string) => void; reject: (e: Error) => void }
    | null = null;

  /** Feed newly received latin1 data. */
  push(data: string): void {
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
    this.socket.write(data, 'latin1');
  }

  close(): void {
    this.socket.destroy();
  }
}
