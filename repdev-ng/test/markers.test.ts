import { describe, it, expect } from 'vitest';
import { diagnosticToMarker, MarkerSeverity } from '../src/renderer/markers.js';

describe('diagnostic -> Monaco marker mapping', () => {
  it('maps an error diagnostic to an Error-severity marker at the right position', () => {
    const m = diagnosticToMarker({ line: 12, column: 5, message: 'Undefined FOO', severity: 'error' });
    expect(m).toEqual({
      severity: MarkerSeverity.Error,
      message: 'Undefined FOO',
      startLineNumber: 12,
      startColumn: 5,
      endLineNumber: 12,
      endColumn: 6,
    });
  });

  it('maps a warning diagnostic to Warning severity', () => {
    const m = diagnosticToMarker({ line: 1, column: 1, message: 'deprecated', severity: 'warning' });
    expect(m.severity).toBe(MarkerSeverity.Warning);
  });
});
