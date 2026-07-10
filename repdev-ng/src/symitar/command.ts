/**
 * Symitar host "command" wire format.
 *
 * Ported faithfully from the private `Command` inner class in
 * com/repdev/DirectSymitarSession.java.
 *
 * Wire format notes (all bytes are treated as latin1 so control bytes survive):
 *
 *   Outgoing (sendStr):
 *     BEL(0x07) + <decimal length of body> + CR(0x0d) + body
 *     body = "Command~key=value~key2=value2~keyWithNoValue"
 *
 *   Incoming (parse): the body string "Command~key=value~..." with the framing
 *   sentinels already stripped by the reader. Embedded file payloads are wrapped
 *   between bytes 0xFD (253) and 0xFE (254).
 */

const BEL = '\x07';
const CR = '\r';
const FILE_DATA_START = String.fromCharCode(253); // 0xFD
const FILE_DATA_END = String.fromCharCode(254); // 0xFE

const COMMAND_PATTERN = /^(.*?)~.*$/s;

/** Module-global message id counter, matching the static counter in Java. */
let currentMessageId = 10000;

/** Reset the message-id counter. Test-only; the Java code never resets it. */
export function resetMessageId(value = 10000): void {
  currentMessageId = value;
}

export class Command {
  command = '';
  parameters = new Map<string, string>();
  /** Raw body the command was parsed from (mirrors Java `data`). */
  data = '';

  constructor(command = '') {
    this.parameters.set('MsgId', String(currentMessageId));
    currentMessageId++;
    this.command = command;
  }

  /** Returns the file payload embedded between 0xFD and 0xFE, or '' if none. */
  getFileData(): string {
    const start = this.data.indexOf(FILE_DATA_START);
    const end = this.data.indexOf(FILE_DATA_END);
    if (start !== -1 && end !== -1) {
      return this.data.substring(start + 1, end);
    }
    return '';
  }

  get(key: string): string | undefined {
    return this.parameters.get(key);
  }

  put(key: string, value: string): this {
    this.parameters.set(key, value);
    return this;
  }

  /** Serializes to the outgoing wire string: BEL + len + CR + body. */
  sendStr(): string {
    let body = this.command + '~';

    for (const [key, value] of this.parameters) {
      body += value === '' ? key + '~' : key + '=' + value + '~';
    }

    // Strip the trailing '~'
    body = body.substring(0, body.length - 1);

    return BEL + body.length + CR + body;
  }

  /**
   * Parses an incoming command body (framing sentinels already removed).
   * Mirrors Java Command.parse: if the body has a '~' and no embedded file
   * payload (0xFD), split into command + key/value params; otherwise the whole
   * body is the command name.
   */
  static parse(data: string): Command {
    const command = new Command();
    command.data = data;

    if (data.indexOf('~') !== -1 && data.indexOf(FILE_DATA_START) === -1) {
      const match = COMMAND_PATTERN.exec(data);
      // Java calls match.matches() then group(1); with a non-greedy (.*?)~ this
      // always matches when a '~' is present.
      const name = match ? match[1] : data;
      command.command = name;

      const rest = data.substring(name.length + 1);
      for (const cur of rest.split('~')) {
        const eq = cur.indexOf('=');
        if (eq === -1) {
          command.parameters.set(cur, '');
        } else {
          command.parameters.set(cur.substring(0, eq), cur.substring(eq + 1));
        }
      }
    } else {
      command.command = data;
    }

    return command;
  }

  toString(): string {
    return this.data;
  }
}
