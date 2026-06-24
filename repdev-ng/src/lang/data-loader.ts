/**
 * Parsers for the RepGen language data files, ported from the Java
 * com.repdev.parser.*Layout singletons:
 *
 *   keywords.txt  -> KeywordLayout      NAME|desc|example      (or bare NAME)
 *   functions.txt -> FunctionLayout     NAME|desc|returnTypes  + \tArg|desc|types
 *   vars.txt      -> SpecialVariables   NAME|desc|type|default (4 fields required)
 *   db.txt        -> DatabaseLayout     [indent]***|REC|Display + \tFIELD|desc|n|type|len
 *
 * Functions take file *content* (not paths) so they are unit-testable without
 * a filesystem and usable from the renderer via Vite `?raw` imports.
 */

export interface Keyword {
  name: string;
  description: string;
  example: string;
}

export interface FunctionArg {
  name: string;
  description: string;
  types: string[];
}

export interface RepgenFunction {
  name: string;
  description: string;
  returnTypes: string[];
  args: FunctionArg[];
}

export interface SpecialVariable {
  name: string;
  description: string;
  type: string;
  defaultValue: number; // -1 when blank, matching the Java sentinel
}

export interface Field {
  name: string;
  description: string;
  number: number;
  type: string; // resolved VariableType name
  length: number; // -1 when "null"
}

export interface DbRecord {
  name: string;
  displayName: string;
  fields: Field[];
  subRecords: DbRecord[];
}

/** VariableType code -> name, ported from VariableType.java. */
const VARIABLE_TYPE_BY_CODE: Record<number, string> = {
  0: 'CHARACTER',
  2: 'RATE',
  3: 'DATE',
  4: 'NUMBER',
  5: 'CODE',
  7: 'MONEY',
  10: 'FLOAT',
  100: 'BOOLEAN',
  [-1]: 'NULL',
};

// Greedy first group, exactly like Java's "(.*)\\|(.*)\\|(.*)".
const THREE_FIELD = /^(.*)\|(.*)\|(.*)$/;
const FOUR_FIELD = /^(.*)\|(.*)\|(.*)\|(.*)$/;
const ARG = /^\t(.*)\|(.*)\|(.*)$/;
const REC = /^(.*)\*\*\*\|(.*)\|(.*)$/;
const FIELD = /^(\s*)([a-zA-Z0-9:]*)\|(.*)\|(.*)\|(.*)\|(.*)$/;

function lines(content: string): string[] {
  return content.split(/\r\n|\r|\n/);
}

export function parseKeywords(content: string): Keyword[] {
  const out: Keyword[] = [];
  for (const line of lines(content)) {
    if (line.length === 0) continue;
    const m = THREE_FIELD.exec(line);
    out.push(m ? { name: m[1], description: m[2], example: m[3] } : { name: line, description: '', example: '' });
  }
  return out;
}

export function parseFunctions(content: string): RepgenFunction[] {
  const out: RepgenFunction[] = [];
  let cur: RepgenFunction | null = null;

  for (const line of lines(content)) {
    if (line.trim().length === 0) continue;

    const argM = ARG.exec(line);
    const funcM = THREE_FIELD.exec(line);

    if (argM && cur) {
      cur.args.push({
        name: argM[1],
        description: argM[2],
        types: argM[3].split(',').map((t) => t.trim().toUpperCase()),
      });
    } else if (funcM) {
      cur = {
        name: funcM[1],
        description: funcM[2],
        returnTypes: funcM[3].split(',').map((t) => t.trim().toUpperCase()),
        args: [],
      };
      out.push(cur);
    } else {
      cur = { name: line.trim(), description: '', returnTypes: [], args: [] };
      out.push(cur);
    }
  }
  return out;
}

export function parseVariables(content: string): SpecialVariable[] {
  const out: SpecialVariable[] = [];
  for (const raw of lines(content)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = FOUR_FIELD.exec(line);
    if (m) {
      out.push({
        name: m[1],
        description: m[2],
        type: m[3],
        defaultValue: m[4].trim() === '' ? -1 : parseInt(m[4], 10),
      });
    }
  }
  return out;
}

export interface Database {
  tree: DbRecord[];
  flat: DbRecord[];
}

export function parseDatabase(content: string): Database {
  const tree: DbRecord[] = [];
  let current: DbRecord | null = null;
  let root: DbRecord | null = null;
  let depth = 0;
  let lastDepth = 0;
  // Track each record's parent to walk back up when depth decreases.
  const parentOf = new Map<DbRecord, DbRecord | null>();

  for (const line of lines(content)) {
    if (line.length === 0) continue;

    if (line.indexOf('***') !== -1) {
      const m = REC.exec(line);
      if (!m) continue;
      depth = m[1].length;

      if (depth > lastDepth) {
        root = current;
      } else if (depth < lastDepth) {
        for (let i = depth; i < lastDepth; i++) {
          root = root ? parentOf.get(root) ?? null : null;
        }
      }

      const rec: DbRecord = { name: m[2], displayName: m[3], fields: [], subRecords: [] };
      parentOf.set(rec, root);
      if (depth === 0) tree.push(rec);
      else root?.subRecords.push(rec);

      current = rec;
      lastDepth = depth;
    } else {
      const m = FIELD.exec(line);
      if (!m || !current) continue;
      const typeCode = parseInt(m[5], 10);
      current.fields.push({
        name: m[2],
        description: m[3],
        number: parseInt(m[4], 10),
        type: VARIABLE_TYPE_BY_CODE[typeCode] ?? 'NULL',
        length: m[6] === 'null' ? -1 : parseInt(m[6], 10),
      });
    }
  }

  const flat: DbRecord[] = [];
  const walk = (recs: DbRecord[]) => {
    for (const r of recs) {
      flat.push(r);
      walk(r.subRecords);
    }
  };
  walk(tree);

  return { tree, flat };
}

export interface LanguageData {
  keywords: Keyword[];
  functions: RepgenFunction[];
  variables: SpecialVariable[];
  database: Database;
}

export function loadLanguageData(sources: {
  keywords: string;
  functions: string;
  variables: string;
  database: string;
}): LanguageData {
  return {
    keywords: parseKeywords(sources.keywords),
    functions: parseFunctions(sources.functions),
    variables: parseVariables(sources.variables),
    database: parseDatabase(sources.database),
  };
}
