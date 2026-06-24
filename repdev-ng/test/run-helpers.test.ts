import { describe, it, expect } from 'vitest';
import {
  parseBatchQueuesAvailable,
  parseQueueTimeSeconds,
  parseReportMeta,
  parseFMPostingName,
  selectQueue,
} from '../src/symitar/run-helpers.js';

describe('runRepGen pure helpers', () => {
  it('expands available-queue ranges and lists', () => {
    expect(parseBatchQueuesAvailable('Batch Queues Available: 0, 1, 3-5, 9')).toEqual([0, 1, 3, 4, 5, 9]);
  });

  it('converts HH:MM:SS queue times to seconds', () => {
    expect(parseQueueTimeSeconds('10:30:45')).toBe(10 * 3600 + 30 * 60 + 45);
    expect(parseQueueTimeSeconds('0:00:05')).toBe(5);
  });

  it('keeps a requested queue when it is available', () => {
    expect(selectQueue(3, new Set([1, 3, 5]), new Map())).toBe(3);
  });

  it('picks the first available empty queue when none requested', () => {
    const available = new Set([0, 1, 3, 4, 5]);
    const counts = new Map([
      [0, 1], // busy
      [1, 0], // empty -> chosen
    ]);
    expect(selectQueue(-1, available, counts)).toBe(1);
  });

  it('falls back to the last available queue when none are known empty', () => {
    const available = new Set([2, 4, 7]);
    expect(selectQueue(-1, available, new Map())).toBe(7);
  });

  it('reroutes an unavailable requested queue', () => {
    expect(selectQueue(8, new Set([2, 4]), new Map())).toBe(4);
  });

  it('parses a REPWRITER report header for time + name', () => {
    const text =
      'Report\nProcessing begun on' + 'X'.repeat(22) + '10:30:45 etc\n(newline when done): NIGHTLY\nbody';
    expect(parseReportMeta(text)).toEqual({ seconds: 10 * 3600 + 30 * 60 + 45, name: 'NIGHTLY' });
  });

  it('returns null when the report header markers are absent', () => {
    expect(parseReportMeta('no markers here')).toBeNull();
  });

  it('parses an FM posting name', () => {
    expect(parseFMPostingName('stuff\nName of Posting: FMTEST POSTING\nmore')).toBe('FMTEST POSTING');
  });
});
