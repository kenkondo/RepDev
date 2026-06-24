import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseKeywords,
  parseFunctions,
  parseVariables,
  parseDatabase,
  loadLanguageData,
} from '../src/lang/data-loader.js';
import { buildCompletions, functionSnippet, highlightWords } from '../src/lang/completions.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/lang/data');
const read = (f: string) => readFileSync(path.join(dataDir, f), 'latin1');

describe('data-loader (synthetic cases)', () => {
  it('parses keyword lines and bare names', () => {
    const kw = parseKeywords('ACCOUNT|Designates account|ACCOUNT:MNEMONIC\nBARE');
    expect(kw[0]).toEqual({ name: 'ACCOUNT', description: 'Designates account', example: 'ACCOUNT:MNEMONIC' });
    expect(kw[1]).toEqual({ name: 'BARE', description: '', example: '' });
  });

  it('parses a function with tab-indented args', () => {
    const fns = parseFunctions('ABS|Absolute value|NUMBER,FLOAT\n\tExpression|An arithmetic expression|NUMBER,FLOAT');
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('ABS');
    expect(fns[0].returnTypes).toEqual(['NUMBER', 'FLOAT']);
    expect(fns[0].args).toEqual([
      { name: 'Expression', description: 'An arithmetic expression', types: ['NUMBER', 'FLOAT'] },
    ]);
  });

  it('parses 4-field variables and drops bare lines', () => {
    const vars = parseVariables('SYSTEMDATE|Current banking date|DATE|\nSYSHOSTNAME');
    expect(vars).toHaveLength(1);
    expect(vars[0]).toEqual({ name: 'SYSTEMDATE', description: 'Current banking date', type: 'DATE', defaultValue: -1 });
  });

  it('parses db records with nested subrecords and field types', () => {
    const db = parseDatabase(
      ['***|ACCOUNT|Account', '\tNUMBER|Account Number|1|0|10', '\t***|SHARE|Share', '\t\tID|Share ID|1|4|5'].join('\n'),
    );
    expect(db.tree).toHaveLength(1);
    expect(db.tree[0].name).toBe('ACCOUNT');
    expect(db.tree[0].fields[0]).toEqual({ name: 'NUMBER', description: 'Account Number', number: 1, type: 'CHARACTER', length: 10 });
    expect(db.tree[0].subRecords[0].name).toBe('SHARE');
    expect(db.flat.map((r) => r.name)).toEqual(['ACCOUNT', 'SHARE']);
  });

  it('builds a Monaco snippet for a function with args', () => {
    const [abs] = parseFunctions('ABS|x|NUMBER\n\tExpression|e|NUMBER');
    expect(functionSnippet(abs)).toBe('ABS(${1:Expression})');
  });
});

describe('data-loader (real RepDev data files)', () => {
  const data = loadLanguageData({
    keywords: read('keywords.txt'),
    functions: read('functions.txt'),
    variables: read('vars.txt'),
    database: read('db.txt'),
  });

  it('loads a substantial, real language model', () => {
    expect(data.keywords.length).toBeGreaterThan(50);
    expect(data.functions.length).toBeGreaterThan(100);
    expect(data.variables.length).toBeGreaterThan(50);
    expect(data.database.flat.length).toBeGreaterThan(20);
  });

  it('finds well-known functions, keywords, records, and variables', () => {
    expect(data.functions.some((f) => f.name === 'ABS')).toBe(true);
    expect(data.keywords.some((k) => k.name === 'ACCOUNT')).toBe(true);
    expect(data.database.flat.some((r) => r.name === 'ACCOUNT')).toBe(true);
    expect(data.variables.some((v) => v.name === 'SYSTEMDATE')).toBe(true);
  });

  it('ACCOUNT record has real fields with resolved types', () => {
    const account = data.database.flat.find((r) => r.name === 'ACCOUNT')!;
    expect(account.fields.length).toBeGreaterThan(5);
    const branch = account.fields.find((f) => f.name === 'BRANCH');
    expect(branch?.type).toBe('CODE'); // type code 5 -> CODE
  });

  it('builds completions across all categories without throwing', () => {
    const items = buildCompletions(data);
    expect(items.length).toBeGreaterThan(data.functions.length);
    expect(items.some((i) => i.kind === 'function' && i.isSnippet)).toBe(true);
    expect(new Set(items.map((i) => i.kind))).toEqual(
      new Set(['function', 'keyword', 'variable', 'field', 'record']),
    );
  });

  it('produces a sane tokenizer highlight set', () => {
    const hw = highlightWords(data);
    expect(hw.functions).toContain('ABS');
    expect(hw.records).toContain('ACCOUNT');
    expect(hw.keywords.every((w) => /^[A-Z0-9_#]+$/.test(w))).toBe(true);
  });
});
