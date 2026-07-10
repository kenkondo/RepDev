/**
 * Pure helpers extracted from DirectSymitarSession.runRepGen — the parsing bits
 * that are easy to get subtly wrong, so they get their own unit tests. The
 * orchestration in session.ts is a thin faithful port that calls these.
 */

/**
 * Parses the "Batch Queues Available: 0, 1, 3-5" display line into the list of
 * available queue numbers. Mirrors the range/list expansion in the Java loop.
 */
export function parseBatchQueuesAvailable(text: string): number[] {
  const out: number[] = [];
  const after = text.substring(text.indexOf(':') + 1);
  for (let part of after.split(',')) {
    part = part.trim();
    if (part === '') continue;
    if (part.indexOf('-') !== -1) {
      const [a, b] = part.split('-');
      const start = parseInt(a.trim(), 10);
      const end = parseInt(b.trim(), 10);
      for (let x = start; x <= end; x++) out.push(x);
    } else {
      out.push(parseInt(part, 10));
    }
  }
  return out;
}

/** Converts an "HH:MM:SS" queue time into seconds (ports the Java arithmetic). */
export function parseQueueTimeSeconds(timeStr: string): number {
  const firstColon = timeStr.indexOf(':');
  const lastColon = timeStr.lastIndexOf(':');
  let secs = parseInt(timeStr.substring(lastColon + 1), 10);
  secs += 60 * parseInt(timeStr.substring(firstColon + 1, lastColon), 10);
  secs += 3600 * parseInt(timeStr.substring(0, firstColon), 10);
  return secs;
}

/**
 * Chooses the batch queue, mirroring the Java selection: if the requested queue
 * is -1 or unavailable, pick the last available queue, preferring the first
 * available *empty* one (count === 0). counts: queue -> running count (-1 = unknown).
 */
export function selectQueue(
  requested: number,
  available: ReadonlySet<number>,
  counts: ReadonlyMap<number, number>,
  maxQueue = 9999,
): number {
  if ((requested !== -1 && !available.has(requested)) || requested === -1) {
    let lastGood = -1;
    for (let q = 0; q <= maxQueue; q++) {
      if (available.has(q)) lastGood = q;
      if (available.has(q) && counts.get(q) === 0) break;
    }
    return lastGood;
  }
  return requested;
}

/**
 * Parses a REPWRITER batch-output report for its start time and report name,
 * ported from SymitarSession.getReportSeqs. The "Processing begun on" marker is
 * followed (41 chars later) by an "HH:MM:SS" time, and the report name follows
 * the "(newline when done):" marker. Returns null if the markers are absent.
 */
export function parseReportMeta(text: string): { seconds: number; name: string } | null {
  const idx = text.indexOf('Processing begun on');
  if (idx < 0) return null;
  let s = text.substring(idx + 41);
  const seconds = parseQueueTimeSeconds(s.substring(0, 8));

  const nIdx = s.indexOf('(newline when done):');
  if (nIdx < 0) return null;
  s = s.substring(nIdx + 21);
  const nl = s.indexOf('\n');
  return { seconds, name: nl < 0 ? s : s.substring(0, nl) };
}

/**
 * Parses an FM posting report for its posting name, ported from
 * SymitarSession.getFMSeqs ("Name of Posting: " marker). Returns null if absent.
 */
export function parseFMPostingName(text: string): string | null {
  const idx = text.indexOf('Name of Posting: ');
  if (idx < 0) return null;
  const s = text.substring(idx + 17);
  const nl = s.indexOf('\n');
  return (nl < 0 ? s : s.substring(0, nl)).trim();
}
