/**
 * Turns parsed LanguageData into editor-agnostic completion items. Pure and
 * tested; the Monaco glue maps CompletionKind -> monaco.CompletionItemKind and
 * the snippet syntax is Monaco's (${1:placeholder}).
 */
import type { LanguageData, RepgenFunction } from './data-loader.js';

export type CompletionKind = 'function' | 'keyword' | 'variable' | 'field' | 'record';

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  detail: string;
  documentation: string;
  insertText: string;
  /** True when insertText uses Monaco snippet placeholders. */
  isSnippet: boolean;
}

/** Builds a snippet like `ABS(${1:Expression})` from a function's args. */
export function functionSnippet(fn: RepgenFunction): string {
  if (fn.args.length === 0) return fn.name;
  const params = fn.args.map((a, i) => `\${${i + 1}:${a.name}}`).join(', ');
  return `${fn.name}(${params})`;
}

export function buildCompletions(data: LanguageData): CompletionItem[] {
  const items: CompletionItem[] = [];

  for (const fn of data.functions) {
    const sig =
      fn.args.length > 0 ? `${fn.name}(${fn.args.map((a) => a.name).join(', ')})` : fn.name;
    items.push({
      label: fn.name,
      kind: 'function',
      detail: fn.returnTypes.length ? `${sig} : ${fn.returnTypes.join('|')}` : sig,
      documentation: fn.description,
      insertText: functionSnippet(fn),
      isSnippet: fn.args.length > 0,
    });
  }

  for (const kw of data.keywords) {
    items.push({
      label: kw.name,
      kind: 'keyword',
      detail: kw.example,
      documentation: kw.description,
      insertText: kw.name,
      isSnippet: false,
    });
  }

  for (const v of data.variables) {
    items.push({
      label: v.name,
      kind: 'variable',
      detail: v.type,
      documentation: v.description,
      insertText: v.name,
      isSnippet: false,
    });
  }

  for (const rec of data.database.flat) {
    items.push({
      label: rec.name,
      kind: 'record',
      detail: rec.displayName,
      documentation: `${rec.name} record (${rec.fields.length} fields)`,
      insertText: rec.name,
      isSnippet: false,
    });
    for (const f of rec.fields) {
      items.push({
        label: f.name,
        kind: 'field',
        detail: `${rec.name}:${f.name} (${f.type})`,
        documentation: f.description,
        insertText: f.name,
        isSnippet: false,
      });
    }
  }

  return items;
}

/** Distinct keyword-ish words for the Monarch tokenizer's highlight set. */
export function highlightWords(data: LanguageData): {
  keywords: string[];
  functions: string[];
  records: string[];
} {
  return {
    keywords: dedupeUpper(data.keywords.map((k) => k.name)),
    functions: dedupeUpper(data.functions.map((f) => f.name)),
    records: dedupeUpper(data.database.flat.map((r) => r.name)),
  };
}

function dedupeUpper(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const u = n.toUpperCase();
    // Only simple identifier words make sense as tokenizer keywords.
    if (!/^[A-Z0-9_#]+$/.test(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}
