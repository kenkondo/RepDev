import { describe, it, expect, beforeEach } from 'vitest';
import { Command, resetMessageId } from '../src/symitar/command.js';

describe('Command wire format', () => {
  beforeEach(() => resetMessageId(10000));

  it('serializes outgoing commands as BEL + len + CR + body', () => {
    const cmd = new Command('Misc');
    cmd.put('InfoType', 'BankingDate');
    const s = cmd.sendStr();

    // BEL prefix, CR separating length from body
    expect(s.charCodeAt(0)).toBe(0x07);
    const crIdx = s.indexOf('\r');
    const lenStr = s.substring(1, crIdx);
    const body = s.substring(crIdx + 1);

    expect(body).toBe('Misc~MsgId=10000~InfoType=BankingDate');
    expect(Number(lenStr)).toBe(body.length);
  });

  it('emits valueless params as bare keys', () => {
    const cmd = new Command('File');
    cmd.put('Done', '');
    const body = cmd.sendStr().split('\r')[1];
    expect(body).toBe('File~MsgId=10000~Done');
  });

  it('parses an incoming command body into name + params', () => {
    const cmd = Command.parse('SymLogonDir~Dir=999~Host=10.0.0.1');
    expect(cmd.command).toBe('SymLogonDir');
    expect(cmd.get('Dir')).toBe('999');
    expect(cmd.get('Host')).toBe('10.0.0.1');
  });

  it('treats a bodiless string as the command name', () => {
    const cmd = Command.parse('Input');
    expect(cmd.command).toBe('Input');
  });

  it('extracts embedded file payloads between 0xFD and 0xFE', () => {
    const content = 'PRINT TITLE\nEND';
    const body = '\xfd' + content + '\xfe';
    const cmd = Command.parse(body);
    expect(cmd.getFileData()).toBe(content);
  });

  it('does not param-split a body that carries a file payload (0xFD present)', () => {
    // payload content contains '~' but must not be parsed as params
    const body = '\xfdA~B~C\xfe';
    const cmd = Command.parse(body);
    expect(cmd.getFileData()).toBe('A~B~C');
  });

  it('round-trips message-id increment across constructions', () => {
    resetMessageId(500);
    expect(new Command('A').get('MsgId')).toBe('500');
    expect(new Command('B').get('MsgId')).toBe('501');
  });
});
