/**
 * Pure mapping from editor-agnostic Diagnostics to Monaco marker data.
 * Kept separate from renderer.ts (which imports monaco) so it can be unit-tested
 * in Node without the editor.
 */
import type { Diagnostic } from '../app/editor-service.js';

/** Mirrors monaco.MarkerSeverity (Error=8, Warning=4). */
export const MarkerSeverity = { Error: 8, Warning: 4 } as const;

export interface MarkerData {
  severity: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export function diagnosticToMarker(d: Diagnostic): MarkerData {
  return {
    severity: d.severity === 'warning' ? MarkerSeverity.Warning : MarkerSeverity.Error,
    message: d.message,
    startLineNumber: d.line,
    startColumn: d.column,
    endLineNumber: d.line,
    // Highlight to end-of-line; Monaco clamps to the line length.
    endColumn: d.column + 1,
  };
}
