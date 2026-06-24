/**
 * SymitarSession — TypeScript port of the protocol-bearing parts of
 * com/repdev/DirectSymitarSession.java (and the SymitarSession abstract API).
 *
 * Scope (Phase 1): the data-plane operations that must round-trip against the
 * host — connect/login handshake, getFile, saveFile (chunked PROT upload with
 * NAK-resend), and errorCheckRepGen. Run-report / FM / print-control come in a
 * later phase; their method stubs document the intended surface.
 *
 * Original work: Copyright (C) 2007 Jake Poznanski, Ryan Schultz, Sean Delaney (GPL-3.0+).
 */
import { Command } from './command.js';
import type { Transport } from './transport.js';
import { SocketTransport, SshTransport } from './transport.js';
import {
  ErrorCheckResult,
  ErrorCheckType,
  FMFile,
  FileType,
  PrintItem,
  SessionError,
  Sequence,
  SymitarFile,
  comparePrintItems,
  fileTypeToProtocol,
  parseSymitarDate,
} from './types.js';
import {
  parseBatchQueuesAvailable,
  parseFMPostingName,
  parseQueueTimeSeconds,
  parseReportMeta,
  selectQueue,
} from './run-helpers.js';

export interface PrintLptOptions {
  formsOverride?: boolean;
  formLength?: number;
  startPage?: number;
  endPage?: number;
  copies?: number;
  landscape?: boolean;
  duplex?: boolean;
  queuePriority?: number;
}

export interface RunFMResult {
  resultTitle: string;
  seq: number;
}

export interface RunRepgenResult {
  seq: number;
  time: number;
}

export interface RunRepgenOptions {
  /** Answers a host prompt; return null to cancel the run. */
  prompter?: (prompt: string) => string | null | Promise<string | null>;
  /** Progress callback: percent 0-100 and an optional status message. */
  onProgress?: (percent: number, message?: string) => void;
}

const ESC = '\x1b'; // 0x1b
const FRAME_START = ESC + String.fromCharCode(0xfe); // ESC 0xFE  -> precedes a command
const FRAME_END = String.fromCharCode(0xfc); // 0xFC          -> ends a command body

/** Don't download more than 2MB (matches Java maxSize). */
const MAX_FILE_SIZE = 2097152;
const PART_SIZE = 3996;

function pad(num: number, width: number): string {
  return String(num).padStart(width, '0');
}

export interface ConnectOptions {
  server: string;
  port: number;
  aixUsername: string;
  aixPassword: string;
  sym: number;
  userID: string;
  transport?: Transport; // injectable for tests; defaults to a TCP socket
  /** Force SSH (default: inferred from port === 22). */
  useSSH?: boolean;
  /** Optional diagnostics sink; receives a line for each handshake step. */
  onLog?: (message: string) => void;
}

export interface SymitarSession {
  connect(opts: ConnectOptions): Promise<SessionError>;
  disconnect(): Promise<SessionError>;
  isConnected(): boolean;
  getFile(file: SymitarFile): Promise<string | null>;
  fileExists(file: SymitarFile): Promise<boolean>;
  saveFile(file: SymitarFile, text: string): Promise<SessionError>;
  getFileList(type: FileType, search: string): Promise<SymitarFile[]>;
  errorCheckRepGen(filename: string): Promise<ErrorCheckResult | null>;
  installRepgen(filename: string): Promise<ErrorCheckResult | null>;
  removeFile(file: SymitarFile): Promise<SessionError>;
  renameFile(file: SymitarFile, newName: string): Promise<SessionError>;
  runRepGen(name: string, queue: number, opts?: RunRepgenOptions): Promise<RunRepgenResult>;
  runBatchFM(
    searchTitle: string,
    searchDays: number,
    file: FMFile,
    queue: number,
    resultTitle?: string,
  ): Promise<RunFMResult>;
  isSeqRunning(seq: number): Promise<boolean>;
  terminateRepgen(seq: number): Promise<void>;
  getPrintItems(query: string, limit: number): Promise<PrintItem[]>;
  getPrintItemsForBatch(seq: Sequence): Promise<PrintItem[]>;
  printFileLPT(file: SymitarFile, queue: number, opts?: PrintLptOptions): Promise<SessionError>;
  printFileTPT(file: SymitarFile, queue: number): Promise<SessionError>;
  getReportSeqs(reportName: string, time: number, search: number, limit: number): Promise<Sequence[]>;
  getFMSeqs(reportName: string, search: number, limit: number): Promise<Sequence[]>;
}

export class DirectSymitarSession implements SymitarSession {
  private transport: Transport | null = null;
  private connected = false;
  private loggedInAIX = false;

  server = '';
  port = 0;
  sym = 0;
  userID = '';
  actualSym = -1;
  consoleNum = -1;
  symRev = '';

  private logFn?: (message: string) => void;

  isConnected(): boolean {
    return this.connected;
  }

  private log(message: string): void {
    this.logFn?.(message);
  }

  /** Escapes control bytes so received data is readable in the diagnostics log. */
  private static sanitize(s: string, max = 200): string {
    const tail = s.length > max ? s.slice(-max) : s;
    return tail.replace(/[\x00-\x1f\x7f-\xff]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  }

  // ---- low-level framing (ports write / readNextCommand / readUntil) --------

  private write(strOrCmd: string | Command): void {
    if (!this.transport) throw new Error('Not connected');
    this.transport.write(typeof strOrCmd === 'string' ? strOrCmd : strOrCmd.sendStr());
  }

  private async readUntil(...markers: string[]): Promise<string> {
    if (!this.transport) throw new Error('Not connected');
    return this.transport.readUntil(...markers);
  }

  /** Ports readNextCommand: locate frame start, read body to 0xFC, parse. */
  private async readNextCommand(): Promise<Command> {
    const tmp = await this.readUntil(FRAME_START, 'No such file or directory');
    if (tmp.indexOf('No such file or directory') !== -1) {
      throw new Error('SYM not Found');
    }

    const data = await this.readUntil(FRAME_END);
    const cmd = Command.parse(data.substring(0, data.length - 1));

    // Filter async messages that arrive out of band and corrupt the stream.
    if (cmd.command === 'MsgDlg' && (cmd.get('Text') ?? '').indexOf('From PID') !== -1) {
      return this.readNextCommand();
    }
    return cmd;
  }

  private wakeUp(): void {
    this.write(new Command('WakeUp'));
  }

  // ---- connect / login ------------------------------------------------------

  async connect(opts: ConnectOptions): Promise<SessionError> {
    if (this.connected) return SessionError.ALREADY_CONNECTED;

    this.server = opts.server;
    this.port = opts.port;
    this.sym = opts.sym;
    this.logFn = opts.onLog;

    const useSSH = opts.useSSH ?? opts.port === 22;
    this.log(`connect: host=${opts.server} port=${opts.port} sym=${opts.sym} user=${opts.aixUsername} mode=${useSSH ? 'SSH' : 'telnet'}`);

    // ---- establish the transport ----
    try {
      if (opts.transport) {
        this.transport = opts.transport;
      } else if (useSSH) {
        this.log('opening SSH connection…');
        this.transport = await SshTransport.connect({
          host: opts.server,
          port: opts.port,
          username: opts.aixUsername,
          password: opts.aixPassword,
        });
        this.log('SSH shell channel established');
      } else {
        this.transport = await SocketTransport.connect(opts.server, opts.port);
        this.log('TCP socket established');
      }
    } catch (e) {
      const msg = (e as Error).message || String(e);
      this.log(`transport connect failed: ${msg}`);
      if (/authentication|password|permission denied/i.test(msg)) {
        return SessionError.AIX_LOGIN_WRONG;
      }
      return SessionError.SERVER_NOT_FOUND;
    }

    try {
      if (!useSSH) {
        // Raw-telnet negotiation bytes (aixterm terminal type), sent verbatim.
        this.write('\xff\xfb\x18');
        this.write('\xff\xfa\x18\x00aixterm\xff\xf0');
        this.write('\xff\xfd\x01');
        this.write('\xff\xfd\x03\xff\xfc\x1f\xff\xfc\x01');

        this.log('telnet: sending AIX username');
        this.write(opts.aixUsername + '\r');
        const temp = await this.readUntil('Password:', 'password:', '[c');
        this.log(`telnet: after username -> ${DirectSymitarSession.sanitize(temp)}`);

        if (temp.indexOf('[c') === -1) {
          this.log('telnet: sending AIX password');
          this.write(opts.aixPassword + '\r');
          const line = await this.readUntil('[c', 'invalid login name or password');
          this.log(`telnet: after password -> ${DirectSymitarSession.sanitize(line)}`);
          if (line.indexOf('invalid login') !== -1) {
            await this.disconnect();
            return SessionError.AIX_LOGIN_WRONG;
          }
        }
      } else {
        this.log('SSH: authenticated via SSH; skipping in-band login prompt');
      }

      this.log('sending WINDOWSLEVEL=3');
      this.write('WINDOWSLEVEL=3\n');
      const temp = await this.readUntil(
        '$ ',
        'SymStart~Global',
        'no longer supported!',
        'Logins not allowed from host: ',
        'Your password has expired.',
        'invalid login name or password',
      );
      this.log(`after WINDOWSLEVEL=3 -> ${DirectSymitarSession.sanitize(temp)}`);

      if (temp.indexOf('no longer supported!') !== -1) {
        await this.disconnect();
        return SessionError.NOT_WINDOWSLEVEL_3;
      } else if (temp.indexOf('Logins not allowed') !== -1) {
        await this.disconnect();
        return SessionError.IP_NOT_ALLOWED;
      } else if (temp.indexOf('Your password has expired.') !== -1) {
        await this.disconnect();
        return SessionError.AIX_PASSWORD_EXPIRED;
      } else if (temp.indexOf('invalid login name or password') !== -1) {
        await this.disconnect();
        return SessionError.AIX_LOGIN_WRONG;
      } else if (temp.indexOf('$ ') !== -1) {
        this.log(`shell prompt detected; sending: sym ${opts.sym}`);
        this.write('sym ' + opts.sym + '\r');
      } else {
        this.log('SymStart~Global detected; console already running');
      }

      // Drain login commands until the host is waiting for input (HelpCode 10025).
      let current: Command;
      try {
        do {
          current = await this.readNextCommand();
          this.log(`login cmd: ${current.command}`);
          if (current.command === 'SymLogonDir') {
            this.actualSym = parseInt((current.get('Dir') ?? '').trim(), 10);
          } else if (current.command === 'SymLogonRev') {
            this.symRev = (current.get('HostRev') ?? '').trim();
          } else if (current.command === 'SymLogonError') {
            const text = current.get('Text') ?? '';
            await this.disconnect();
            if (text.indexOf('Too Many Invalid Password Attempts') !== -1)
              return SessionError.CONSOLE_BLOCKED;
            if (text.indexOf('Revision Incompatibility') !== -1)
              return SessionError.INCOMPATIBLE_REVISION;
            if (text.indexOf('DBMS Not Available') !== -1) return SessionError.DBMS_NOT_AVAILABLE;
            return SessionError.UNDEFINED_ERROR;
          }
        } while (current.command !== 'Input' || current.get('HelpCode') !== '10025');
      } catch (e) {
        const msg = (e as Error).message;
        this.log(`login drain error: ${msg}`);
        await this.disconnect();
        return msg.indexOf('SYM not Found') !== -1
          ? SessionError.SYM_INVALID
          : SessionError.IO_ERROR;
      }
    } catch (e) {
      this.log(`handshake error: ${(e as Error).stack ?? String(e)}`);
      await this.disconnect();
      return SessionError.IO_ERROR;
    }

    this.loggedInAIX = true;
    this.log('AIX login complete; logging into SYM');
    return this.loginUser(opts.userID);
  }

  async loginUser(userID: string): Promise<SessionError> {
    if (!this.loggedInAIX) return SessionError.NOT_CONNECTED;
    this.userID = userID;

    try {
      this.write(userID + '\r');
      let current = await this.readNextCommand();

      if (current.command === 'MsgDlg') {
        this.write('\r0\r');
        current = await this.readNextCommand();
      }

      if (current.command === 'SymLogonInvalidUser') {
        this.write('\r');
        while ((current = await this.readNextCommand()).command !== 'Input') {
          /* drain */
        }
        return SessionError.USERID_INVALID;
      } else if (current.command === 'SymLogonFrozen') {
        await this.disconnect();
        return SessionError.CONSOLE_BLOCKED;
      } else if (current.command === 'SymLogonChangePassword') {
        await this.disconnect();
        return SessionError.USERID_PASSWORD_CHANGE;
      }

      this.write('\r');
      await this.readNextCommand();
      this.write('\r');
      await this.readNextCommand();

      // Banking date
      const dateCmd = new Command('Misc');
      dateCmd.put('InfoType', 'BankingDate');
      this.write(dateCmd);
      await this.readNextCommand();

      // Console number
      const conCmd = new Command('Misc');
      conCmd.put('InfoType', 'ConsoleNumber');
      this.write(conCmd);
      const conResp = await this.readNextCommand();
      const cn = conResp.get('ConsoleNumber');
      if (cn !== undefined) this.consoleNum = parseInt(cn, 10);

      this.connected = true;
    } catch {
      await this.disconnect();
      return SessionError.IO_ERROR;
    }

    return SessionError.NONE;
  }

  async disconnect(): Promise<SessionError> {
    try {
      this.transport?.close();
    } catch {
      return SessionError.IO_ERROR;
    } finally {
      this.transport = null;
      this.connected = false;
      this.loggedInAIX = false;
    }
    return SessionError.NONE;
  }

  // ---- data plane -----------------------------------------------------------

  /** Ports getFile: File/Retrieve, then drain payload frames until Done. */
  async getFile(file: SymitarFile): Promise<string | null> {
    if (!this.connected) return null;

    const retrieve = new Command('File');
    retrieve.put('Action', 'Retrieve');
    const proto = fileTypeToProtocol(file.type);
    if (proto) retrieve.put('Type', proto);
    retrieve.put('Name', file.name);
    this.write(retrieve);

    let data = '';
    let wroteSizeWarning = false;
    try {
      for (;;) {
        const current = await this.readNextCommand();
        const status = current.get('Status');
        if (status !== undefined && status.indexOf('No such file or directory') !== -1) return '';
        if (status !== undefined) return null;
        if (current.get('Done') !== undefined) return data;

        if (data.length < MAX_FILE_SIZE) {
          data += current.getFileData();
          if (file.type === FileType.REPORT) data += '\n';
        } else if (!wroteSizeWarning) {
          const warn =
            'WARNING - This file exceeds the 2MB limit that RepDev has for loading files. This text should only be used as a preview!';
          data = warn + '\n\n' + data + '\n\n' + warn;
          wroteSizeWarning = true;
        }
      }
    } catch {
      return null;
    }
  }

  async fileExists(file: SymitarFile): Promise<boolean> {
    return (await this.getFileList(file.type, file.name)).length > 0;
  }

  /** Ports saveFile: File/Store, strip bad chars, chunked PROT upload w/ NAK-resend. */
  async saveFile(file: SymitarFile, text: string): Promise<SessionError> {
    if (!this.connected) return SessionError.NOT_CONNECTED;
    if (file == null || text == null) return SessionError.ARGUMENT_ERROR;

    const store = new Command('File');
    store.put('Action', 'Store');
    const proto = fileTypeToProtocol(file.type);
    if (proto) store.put('Type', proto);
    store.put('Name', file.name);

    this.wakeUp();
    this.write(store);

    try {
      let current = await this.readNextCommand();

      // Wait for the BadCharList reply (bounded, like the Java breakcount).
      let breakcount = 0;
      while (current.toString().indexOf('BadCharList') === -1) {
        current = await this.readNextCommand();
        if (breakcount++ > 5) return SessionError.NULL_POINTER;
      }

      const status = current.get('Status');
      if (status !== undefined && status.indexOf('Filename is too long') !== -1) {
        return SessionError.FILENAME_TOO_LONG;
      }

      const badList = (current.get('BadCharList') ?? '').split(',');
      let body = text;
      for (const cur of badList) {
        if (cur === '') continue;
        const code = parseInt(cur, 10);
        if (!Number.isNaN(code)) body = body.split(String.fromCharCode(code)).join('');
      }

      let curPart = 0;
      do {
        let toSend: string;
        let ack: string;
        do {
          toSend = body.substring(0, Math.min(body.length, PART_SIZE));
          this.write('PROT' + pad(curPart, 3) + 'DATA' + pad(toSend.length, 5));
          this.write(toSend);
          ack = await this.transport!.read(16);
        } while (ack[7] === 'N'); // NAK -> resend this part

        curPart++;
        body = body.substring(toSend.length);
      } while (body.length > 0);

      this.write('PROT' + pad(curPart, 3) + 'EOF' + '      '); // 6 spaces of pad
      await this.transport!.read(16);

      current = await this.readNextCommand();
      this.write(new Command('WakeUp'));
      if (current.toString().indexOf('Unable to save on Output Open') >= 0) {
        return SessionError.FILE_READ_ONLY;
      }
    } catch {
      return SessionError.IO_ERROR;
    }
    return SessionError.NONE;
  }

  /** Ports getFileList: File list query, collect names until done. */
  async getFileList(type: FileType, search: string): Promise<SymitarFile[]> {
    if (!this.connected) return [];
    const list = new Command('File');
    const proto = fileTypeToProtocol(type);
    if (proto) list.put('Type', proto);
    list.put('Action', 'List');
    if (search) list.put('Name', search);
    this.write(list);

    const out: SymitarFile[] = [];
    try {
      for (;;) {
        const current = await this.readNextCommand();
        if (current.get('Done') !== undefined) return out;
        const name = current.get('Name');
        if (name !== undefined && name !== '') out.push({ sym: this.sym, name, type });
      }
    } catch {
      return out;
    }
  }

  /**
   * Drives Management Menu #3 (RepGen) to the given option, sends the filename,
   * and returns the first response command. Option 7 = error-check only,
   * option 8 = compile + install. Shared by errorCheckRepGen / installRepgen.
   */
  private async repgenMenu(option: '7' | '8', filename: string): Promise<Command> {
    this.write('mm3' + ESC); // Management menu #3 - repgen
    let cur: Command;
    while ((cur = await this.readNextCommand()).command !== 'Input') {
      /* drain */
    }
    this.write(option + '\r');
    await this.readNextCommand();
    await this.readNextCommand();
    this.write(filename + '\r');
    return this.readNextCommand();
  }

  /**
   * Reads the FileInfo/ErrText/DisplayEdit error block that follows an "Init"
   * SpecfileErr, returning an ERROR result with line/col/message. Shared by the
   * error path of errorCheckRepGen and installRepgen.
   */
  private async readSpecfileError(cur: Command, fallbackName: string): Promise<ErrorCheckResult> {
    const errFile = cur.get('FileName') ?? fallbackName;
    let line = -1;
    let column = -1;
    let error = '';
    while ((cur = await this.readNextCommand()).get('Action') !== 'DisplayEdit') {
      if (cur.get('Action') === 'FileInfo') {
        line = parseInt((cur.get('Line') ?? '-1').replace(/,/g, ''), 10);
        column = parseInt((cur.get('Col') ?? '-1').replace(/,/g, ''), 10);
      } else if (cur.get('Action') === 'ErrText') {
        error += (cur.get('Line') ?? '') + ' ';
      }
    }
    await this.readNextCommand();
    return result(errFile, error.trim(), line, column, ErrorCheckType.ERROR);
  }

  /** Ports errorCheckRepGen: drive Management Menu #3 option 7 and parse results. */
  async errorCheckRepGen(filename: string): Promise<ErrorCheckResult | null> {
    if (!this.connected) return null;

    try {
      this.write('mm3' + ESC); // Management menu #3 - repgen
      let cur: Command;
      while ((cur = await this.readNextCommand()).command !== 'Input') {
        /* drain */
      }

      this.write('7\r');
      await this.readNextCommand();
      await this.readNextCommand();

      this.write(filename + '\r');
      while (
        (cur = await this.readNextCommand()).command !== 'SpecfileErr' &&
        cur.command !== 'MsgDlg'
      ) {
        /* drain */
      }

      if (cur.get('Type') !== undefined) {
        return result(filename, 'File does not exist on server!', -1, -1, ErrorCheckType.ERROR);
      }
      if (cur.get('Warning') !== undefined || cur.get('Error') !== undefined) {
        await this.readNextCommand();
        return result(filename, 'File does not exist on server!', -1, -1, ErrorCheckType.ERROR);
      }
      if (cur.get('Action') === 'NoError') {
        await this.readNextCommand();
        return result(filename, '', -1, -1, ErrorCheckType.NO_ERROR);
      }
      if (cur.get('Action') === 'Init') {
        return this.readSpecfileError(cur, filename);
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Ports installRepgen: Management Menu #3 option 8 — compiles AND installs the
   * RepGen on the host. On success the host replies with SpecfileData carrying
   * the install Size; on failure it returns the same Init error block as
   * errorCheckRepGen. This is the real "compile" path (option 7 only checks).
   */
  async installRepgen(filename: string): Promise<ErrorCheckResult | null> {
    if (!this.connected) return null;

    try {
      let cur = await this.repgenMenu('8', filename);

      if (cur.get('Warning') !== undefined || cur.get('Error') !== undefined) {
        await this.readNextCommand();
        return result(filename, 'File does not exist on server!', -1, -1, ErrorCheckType.ERROR);
      }

      if (cur.command === 'SpecfileData') {
        // Confirm the install: read prompt, answer "1", drain the two trailing
        // commands, then report the installed size.
        await this.readNextCommand();
        this.write('1\r');
        await this.readNextCommand();
        await this.readNextCommand();
        const size = parseInt((cur.get('Size') ?? '0').replace(/,/g, ''), 10);
        return {
          file: filename,
          errorMessage: '',
          lineNumber: -1,
          column: -1,
          type: ErrorCheckType.INSTALLED_SUCCESSFULLY,
          installSize: size,
        };
      }

      if (cur.get('Action') === 'Init') {
        return this.readSpecfileError(cur, filename);
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Ports removeFile: File/Delete, inspect Status/Done. */
  async removeFile(file: SymitarFile): Promise<SessionError> {
    if (!this.connected) return SessionError.NOT_CONNECTED;
    return this.fileMutation(file, 'Delete');
  }

  /** Ports renameFile: File/Rename with NewName, inspect Status/Done. */
  async renameFile(file: SymitarFile, newName: string): Promise<SessionError> {
    if (!this.connected) return SessionError.NOT_CONNECTED;
    return this.fileMutation(file, 'Rename', newName);
  }

  private async fileMutation(
    file: SymitarFile,
    action: 'Delete' | 'Rename',
    newName?: string,
  ): Promise<SessionError> {
    const cmd = new Command('File');
    cmd.put('Action', action);
    const proto = fileTypeToProtocol(file.type);
    if (proto) cmd.put('Type', proto);
    cmd.put('Name', file.name);
    if (newName !== undefined) cmd.put('NewName', newName);
    this.write(cmd);

    try {
      const current = await this.readNextCommand();
      const status = current.get('Status');
      if (status !== undefined && status.indexOf('No such file or directory') !== -1)
        return SessionError.ARGUMENT_ERROR;
      if (status !== undefined) return SessionError.FILENAME_TOO_LONG;
      if (current.get('Done') !== undefined) return SessionError.NONE;
    } catch {
      return SessionError.IO_ERROR;
    }
    return SessionError.IO_ERROR;
  }

  /**
   * Ports runRepGen: drives Management Menu #0 to queue a batch run, answering
   * prompts via opts.prompter, selecting a batch queue, and returning the
   * sequence/time of the queued job. Returns {seq:-1} on cancel/error.
   */
  async runRepGen(name: string, queue: number, opts: RunRepgenOptions = {}): Promise<RunRepgenResult> {
    const progress = (pct: number, msg?: string) => opts.onProgress?.(pct, msg);
    let seq = -1;
    let time = 0;

    const drainToInput = async (): Promise<Command> => {
      let cur: Command;
      do {
        cur = await this.readNextCommand();
      } while (cur.command !== 'Input');
      return cur;
    };

    try {
      progress(0, 'Queuing batch run, please wait...');
      this.write('mm0' + ESC);
      await drainToInput();
      progress(5);
      this.write('1\r');
      await drainToInput();
      progress(10);
      this.write('11\r');
      await drainToInput();
      progress(15, 'Please answer prompts');
      this.write(name + '\r');

      // Prompt / batch-output loop until the run-confirmation Input (20301).
      for (;;) {
        const cur = await this.readNextCommand();
        if (cur.command === 'Input' && cur.get('HelpCode') === '20301') break;

        if (cur.command === 'Input') {
          const promptName = cur.get('Prompt') ?? '';
          const answer = opts.prompter ? await opts.prompter(promptName) : null;
          if (answer == null) {
            this.write(ESC);
            await drainToInput();
            return { seq: -1, time: 0 };
          }
          this.write(answer.trim() + '\r');
        } else if (
          cur.command === 'Batch' &&
          (cur.get('Text') ?? '').indexOf('No such file or directory') !== -1
        ) {
          await drainToInput();
          progress(100, 'Error: No such file or directory');
          return { seq: -1, time: 0 };
        } else if (cur.command === 'SpecfileErr') {
          // Error display lines follow; surface and bail.
          await drainToInput();
          progress(100, 'There was an error in your program preventing it from running');
          return { seq: -1, time: 0 };
        }
      }

      this.write('\r');
      await drainToInput();
      progress(20);
      this.write('0\r');

      // Read the queue-availability list up to the next Input.
      const available = new Set<number>();
      {
        let cur: Command;
        while ((cur = await this.readNextCommand()).command !== 'Input') {
          if (
            cur.get('Action') === 'DisplayLine' &&
            (cur.get('Text') ?? '').indexOf('Batch Queues Available:') !== -1
          ) {
            for (const q of parseBatchQueuesAvailable(cur.get('Text')!)) available.add(q);
          }
        }
      }
      progress(25);

      // First BatchQueues query: count running jobs per queue.
      const counts = new Map<number, number>();
      const getQueues = new Command('Misc');
      getQueues.put('InfoType', 'BatchQueues');
      this.write(getQueues);
      {
        let cur: Command;
        while ((cur = await this.readNextCommand()).get('Done') === undefined) {
          if (cur.get('Action') === 'QueueEntry' && cur.get('Stat') === 'Running') {
            const q = parseInt(cur.get('Queue')!, 10);
            counts.set(q, (counts.get(q) ?? -1) < 0 ? 1 : (counts.get(q) ?? 0) + 1);
          } else if (cur.get('Action') === 'QueueEmpty') {
            counts.set(parseInt(cur.get('Queue')!, 10), 0);
          }
        }
      }

      const chosen = selectQueue(queue, available, counts);
      this.write(chosen + '\r');
      await drainToInput();
      progress(30);
      this.write('1\r');
      await drainToInput();

      // Second BatchQueues query: find the newest running job's seq/time.
      this.write(getQueues);
      let newestTime = 0;
      {
        let cur: Command;
        while ((cur = await this.readNextCommand()).get('Done') === undefined) {
          if (cur.get('Action') === 'QueueEntry' && cur.get('Stat') !== 'Scheduled') {
            const curTime = parseQueueTimeSeconds(cur.get('Time')!);
            if (curTime > newestTime) {
              newestTime = curTime;
              seq = parseInt(cur.get('Seq')!, 10);
              time = curTime;
            }
          }
        }
      }
    } catch {
      return { seq: -1, time: 0 };
    }

    progress(50, 'Repgen queued\nWaiting for batch job to finish');
    return { seq, time };
  }

  // ---- shared queue helpers (used by runBatchFM / isSeqRunning) -------------

  /** Reads commands until the next Input, collecting "Batch Queues Available:" lines. */
  private async collectAvailableQueues(): Promise<Set<number>> {
    const available = new Set<number>();
    let cur: Command;
    while ((cur = await this.readNextCommand()).command !== 'Input') {
      if (
        cur.get('Action') === 'DisplayLine' &&
        (cur.get('Text') ?? '').indexOf('Batch Queues Available:') !== -1
      ) {
        for (const q of parseBatchQueuesAvailable(cur.get('Text')!)) available.add(q);
      }
    }
    return available;
  }

  /** Issues a BatchQueues query and tallies running jobs per queue until Done. */
  private async collectQueueCounts(): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    const getQueues = new Command('Misc');
    getQueues.put('InfoType', 'BatchQueues');
    this.write(getQueues);
    let cur: Command;
    while ((cur = await this.readNextCommand()).get('Done') === undefined) {
      if (cur.get('Action') === 'QueueEntry' && cur.get('Stat') === 'Running') {
        const q = parseInt(cur.get('Queue')!, 10);
        counts.set(q, (counts.get(q) ?? -1) < 0 ? 1 : (counts.get(q) ?? 0) + 1);
      } else if (cur.get('Action') === 'QueueEmpty') {
        counts.set(parseInt(cur.get('Queue')!, 10), 0);
      }
    }
    return counts;
  }

  /**
   * Ports runBatchFM: drives Management Menu #0 → 1 → 24 → 5 to perform batch FM
   * from a PowerOn output report, selects a queue, and returns the result title
   * and queued sequence.
   */
  async runBatchFM(
    searchTitle: string,
    searchDays: number,
    file: FMFile,
    queue: number,
    resultTitle = `RepDev FM - ${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`,
  ): Promise<RunFMResult> {
    const result: RunFMResult = { resultTitle, seq: -1 };
    if (!this.connected) return result;

    const drainToInput = async (): Promise<Command> => {
      let cur: Command;
      do {
        cur = await this.readNextCommand();
      } while (cur.command !== 'Input');
      return cur;
    };

    try {
      this.write('mm0' + ESC);
      await drainToInput();
      this.write('1\r');
      await drainToInput();
      this.write('24\r');
      await drainToInput();
      this.write('5\r'); // Perform FM from PowerOn Output
      await drainToInput();
      this.write(file + '\r'); // FMFile ordinal
      await drainToInput();
      this.write('0\r'); // Undo a Posting from FM Posting Journal?
      await drainToInput();
      this.write(searchTitle + '\r'); // Report Title
      await drainToInput();
      this.write(searchDays + '\r'); // Limit Search Days
      await drainToInput();
      if (file === FMFile.ACCOUNT) {
        this.write('1\r'); // Record FM History?
        await drainToInput();
      }
      this.write(resultTitle + '\r'); // Name of Posting
      await drainToInput();
      this.write('1\r'); // Produce Empty Report if No Exceptions
      let cur = await drainToInput();
      if (cur.command === 'Input' && cur.get('HelpCode') === '25514') {
        this.write('0\r'); // Produce Empty Report if No Locking Excp?
        await drainToInput();
      }

      this.write('0\r'); // Batch Options? -> collect queue list
      const available = await this.collectAvailableQueues();
      const counts = await this.collectQueueCounts();

      const chosen = selectQueue(queue, available, counts);
      this.write(chosen + '\r');
      await drainToInput();
      this.write('1\r');
      await drainToInput();

      // Newest running job's sequence (FM includes all QueueEntry, not just non-scheduled).
      const getQueues = new Command('Misc');
      getQueues.put('InfoType', 'BatchQueues');
      this.write(getQueues);
      let newestTime = 0;
      while ((cur = await this.readNextCommand()).get('Done') === undefined) {
        if (cur.get('Action') === 'QueueEntry') {
          const curTime = parseQueueTimeSeconds(cur.get('Time')!);
          if (curTime > newestTime) {
            newestTime = curTime;
            result.seq = parseInt(cur.get('Seq')!, 10);
          }
        }
      }
    } catch {
      return result;
    }
    return result;
  }

  /** Ports isSeqRunning: BatchQueues query, true if any entry matches seq. */
  async isSeqRunning(seq: number): Promise<boolean> {
    if (!this.connected) return false;
    const getQueues = new Command('Misc');
    getQueues.put('InfoType', 'BatchQueues');
    this.write(getQueues);
    let running = false;
    try {
      let cur: Command;
      while ((cur = await this.readNextCommand()).get('Done') === undefined) {
        if (cur.get('Action') === 'QueueEntry' && parseInt(cur.get('Seq')!, 10) === seq) {
          running = true;
        }
      }
    } catch {
      return false;
    }
    return running;
  }

  /** terminateRepgen was a no-op upstream; kept for interface parity. */
  async terminateRepgen(_seq: number): Promise<void> {
    /* not implemented in the original RepDev */
  }

  /**
   * Ports getPrintItems(query, limit): lists recent Report files in print
   * control matching `query`, newest first (capped at 40 like the original).
   */
  async getPrintItems(query: string, limit: number): Promise<PrintItem[]> {
    if (!this.connected) return [];
    limit = Math.min(40, limit);

    const cmd = new Command('File');
    cmd.put('Action', 'List');
    cmd.put('MaxCount', '50');
    cmd.put('Query', `LAST ${limit} "+${query}+"`);
    cmd.put('Type', 'Report');
    this.write(cmd);

    return this.readPrintItems();
  }

  /**
   * Ports getPrintItems(Sequence): lists Report files for a specific batch
   * sequence, keeping only those on the same day as the sequence's date.
   */
  async getPrintItemsForBatch(seq: Sequence): Promise<PrintItem[]> {
    if (!this.connected) return [];
    const cmd = new Command('File');
    cmd.put('Action', 'List');
    cmd.put('MaxCount', '300');
    cmd.put('Query', `BATCH ${seq.seq}`);
    cmd.put('Type', 'Report');
    this.write(cmd);

    const seqDay = seq.date.getDate();
    const seqMonth = seq.date.getMonth();
    const items = await this.readPrintItems();
    return items.filter((it) => it.date && it.date.getDate() === seqDay && it.date.getMonth() === seqMonth);
  }

  /** Reads print-control list responses (with Sequence params) until Done. */
  private async readPrintItems(): Promise<PrintItem[]> {
    const items: PrintItem[] = [];
    try {
      let cur: Command;
      while ((cur = await this.readNextCommand()).get('Done') === undefined) {
        if (cur.get('Sequence') !== undefined) {
          items.push({
            title: cur.get('Title') ?? '',
            seq: parseInt(cur.get('Sequence')!, 10),
            size: parseInt(cur.get('Size') ?? '0', 10),
            pages: parseInt(cur.get('PageCount') ?? '0', 10),
            batchSeq: parseInt(cur.get('BatchSeq') ?? '0', 10),
            date: parseSymitarDate(cur.get('Date') ?? '', cur.get('Time')),
          });
        }
      }
    } catch {
      /* fall through with what we have */
    }
    items.sort(comparePrintItems);
    return items;
  }

  /**
   * Ports printFileLPT: drives Management Menu #1 print dialog to send a Report
   * to an LPT print queue with the given options. Returns INVALID_QUEUE /
   * INPUT_ERROR on host error dialogs.
   */
  async printFileLPT(file: SymitarFile, queue: number, opts: PrintLptOptions = {}): Promise<SessionError> {
    if (!this.connected) return SessionError.NOT_CONNECTED;
    if (file.type !== FileType.REPORT) return SessionError.INVALID_FILE_TYPE;

    const {
      formsOverride = false,
      formLength = 0,
      startPage = 0,
      endPage = 0,
      copies = 1,
      landscape = false,
      duplex = false,
    } = opts;

    const drainToInput = async (): Promise<Command> => {
      let cur: Command;
      do {
        cur = await this.readNextCommand();
      } while (cur.command !== 'Input');
      return cur;
    };

    try {
      this.write('mm1' + ESC);
      await drainToInput();
      this.write('P\r');
      await drainToInput();
      this.write(file.name + '\r');
      await drainToInput();
      this.write('\r');

      // Wait for the queue prompt (HelpCode 10008).
      let cur: Command;
      do {
        cur = await this.readNextCommand();
      } while (!(cur.command === 'Input' && cur.get('HelpCode') === '10008'));

      this.write(queue + '\r');
      while ((cur = await this.readNextCommand()).command !== 'Input') {
        if (cur.command === 'MsgDlg' && cur.get('Type') === 'Error') {
          this.wakeUp();
          return SessionError.INVALID_QUEUE;
        }
      }

      this.write('\r');
      cur = await drainToInput();
      // Optional banner-page prompt (HelpCode 10026).
      if (cur.command === 'Input' && cur.get('HelpCode') === '10026') {
        this.write('0\r');
        await drainToInput();
      }

      this.write((formsOverride ? '1' : '0') + '\r');
      await drainToInput();
      if (formsOverride) {
        this.write(formLength + '\r');
        await drainToInput();
      }
      this.write(startPage + '\r');
      await drainToInput();
      this.write(endPage + '\r');
      await drainToInput();
      this.write(copies + '\r');
      await drainToInput();
      this.write((landscape ? '1' : '0') + '\r');
      await drainToInput();
      this.write((duplex ? '1' : '0') + '\r');
      await drainToInput();
      this.write('4\r');
      while ((cur = await this.readNextCommand()).command !== 'Input') {
        if (cur.command === 'MsgDlg' && cur.get('Type') === 'Error') {
          this.wakeUp();
          return SessionError.INPUT_ERROR;
        }
      }
    } catch {
      return SessionError.IO_ERROR;
    }
    return SessionError.NONE;
  }

  /** printFileTPT was never implemented upstream; kept as a no-op for parity. */
  async printFileTPT(_file: SymitarFile, _queue: number): Promise<SessionError> {
    return SessionError.NONE;
  }

  /**
   * Ports getReportSeqs: finds batch sequences for a REPWRITER report by name,
   * optionally matching a start time (±1s, or -1 for "any"). Reads candidate
   * report files newest-first and parses their headers.
   */
  async getReportSeqs(
    reportName: string,
    time: number,
    search: number,
    limit: number,
  ): Promise<Sequence[]> {
    const items = await this.getPrintItems('REPWRITER', search);
    const out: Sequence[] = [];
    // Newest first.
    items.reverse();

    for (const cur of items) {
      const text = await this.getFile({ sym: this.sym, name: String(cur.seq), type: FileType.REPORT });
      if (text == null) continue;
      const meta = parseReportMeta(text);
      if (!meta) continue;

      const matchesTime =
        time === -1 || meta.seconds - 1 === time || meta.seconds === time || meta.seconds + 1 === time;
      if (matchesTime && meta.name === reportName) {
        out.push({ sym: this.sym, seq: cur.batchSeq, date: cur.date ?? new Date(0) });
        if (time !== -1 || out.length >= limit) break;
      }
    }
    return out;
  }

  /** Ports getFMSeqs: finds batch sequences for an FM posting by its name. */
  async getFMSeqs(reportName: string, search: number, limit: number): Promise<Sequence[]> {
    const items = await this.getPrintItems('MISCFMPOST', search);
    const out: Sequence[] = [];
    items.reverse();

    for (const cur of items) {
      const text = await this.getFile({ sym: this.sym, name: String(cur.seq), type: FileType.REPORT });
      if (text == null) continue;
      const name = parseFMPostingName(text);
      if (name === reportName) {
        out.push({ sym: this.sym, seq: cur.batchSeq, date: cur.date ?? new Date(0) });
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}

function result(
  file: string,
  errorMessage: string,
  lineNumber: number,
  column: number,
  type: ErrorCheckType,
): ErrorCheckResult {
  return { file, errorMessage, lineNumber, column, type };
}
