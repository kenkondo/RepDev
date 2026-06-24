/**
 * Registers the RepGen language with Monaco: a Monarch tokenizer for syntax
 * highlighting and a completion provider, both driven by the parsed
 * LanguageData. Takes the monaco namespace as a parameter so this module has no
 * hard dependency on the editor at import time.
 */
import type * as Monaco from 'monaco-editor';
import type { LanguageData } from './data-loader.js';
import { buildCompletions, highlightWords, type CompletionKind } from './completions.js';

export const REPGEN_LANGUAGE_ID = 'repgen';

function kindToMonaco(
  monaco: typeof Monaco,
  kind: CompletionKind,
): Monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case 'function':
      return K.Function;
    case 'keyword':
      return K.Keyword;
    case 'variable':
      return K.Variable;
    case 'field':
      return K.Field;
    case 'record':
      return K.Struct;
  }
}

export function registerRepgenLanguage(monaco: typeof Monaco, data: LanguageData): void {
  // Idempotent: bail if already registered.
  if (monaco.languages.getLanguages().some((l) => l.id === REPGEN_LANGUAGE_ID)) return;

  monaco.languages.register({ id: REPGEN_LANGUAGE_ID });

  const words = highlightWords(data);

  monaco.languages.setMonarchTokensProvider(REPGEN_LANGUAGE_ID, {
    ignoreCase: true,
    keywords: words.keywords,
    functions: words.functions,
    records: words.records,
    tokenizer: {
      root: [
        [/#?[a-zA-Z][\w:]*/, {
          cases: {
            '@functions': 'support.function',
            '@records': 'type',
            '@keywords': 'keyword',
            '@default': 'identifier',
          },
        }],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\d+(\.\d+)?/, 'number'],
        [/;.*$/, 'comment'], // RepGen line comments start with ';'
        [/[{}()\[\]]/, '@brackets'],
        [/[=<>+\-*/]/, 'operator'],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration(REPGEN_LANGUAGE_ID, {
    comments: { lineComment: ';' },
    brackets: [
      ['{', '}'],
      ['(', ')'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });

  const items = buildCompletions(data);

  monaco.languages.registerCompletionItemProvider(REPGEN_LANGUAGE_ID, {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: Monaco.languages.CompletionItem[] = items.map((it) => ({
        label: it.label,
        kind: kindToMonaco(monaco, it.kind),
        detail: it.detail,
        documentation: it.documentation,
        insertText: it.insertText,
        insertTextRules: it.isSnippet
          ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
          : undefined,
        range,
      }));

      return { suggestions };
    },
  });
}
