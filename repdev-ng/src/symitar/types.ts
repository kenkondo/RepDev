/**
 * Ported domain types from the Java RepDev project.
 *
 *   - SessionError       (com/repdev/SessionError.java)
 *   - FileType           (com/repdev/FileType.java)
 *   - ErrorCheckResult   (com/repdev/ErrorCheckResult.java)
 *   - SymitarFile        (subset of com/repdev/SymitarFile.java relevant to the protocol)
 *
 * Original work: Copyright (C) 2007 Jake Poznanski, Ryan Schultz, Sean Delaney (GPL-3.0+).
 */

/** Result codes returned by every SymitarSession operation. Ported from SessionError.java. */
export enum SessionError {
  NONE = 'NONE',
  SERVER_NOT_FOUND = 'SERVER_NOT_FOUND',
  AIX_LOGIN_WRONG = 'AIX_LOGIN_WRONG',
  SYM_INVALID = 'SYM_INVALID',
  USERID_INVALID = 'USERID_INVALID',
  USERID_PASSWORD_CHANGE = 'USERID_PASSWORD_CHANGE',
  ALREADY_CONNECTED = 'ALREADY_CONNECTED',
  NOT_CONNECTED = 'NOT_CONNECTED',
  IO_ERROR = 'IO_ERROR',
  CONSOLE_BLOCKED = 'CONSOLE_BLOCKED',
  INVALID_FILE_TYPE = 'INVALID_FILE_TYPE',
  INVALID_QUEUE = 'INVALID_QUEUE',
  INPUT_ERROR = 'INPUT_ERROR',
  IP_NOT_ALLOWED = 'IP_NOT_ALLOWED',
  FILENAME_TOO_LONG = 'FILENAME_TOO_LONG',
  ARGUMENT_ERROR = 'ARGUMENT_ERROR',
  NULL_POINTER = 'NULL_POINTER',
  PLINK_NOT_FOUND = 'PLINK_NOT_FOUND',
  NOT_WINDOWSLEVEL_3 = 'NOT_WINDOWSLEVEL_3',
  NOT_WINDOWSLEVEL_3_PASS_WILL_EXPIRE = 'NOT_WINDOWSLEVEL_3_PASS_WILL_EXPIRE',
  INCOMPATIBLE_REVISION = 'INCOMPATIBLE_REVISION',
  UNDEFINED_ERROR = 'UNDEFINED_ERROR',
  AIX_PASSWORD_TO_EXPIRE = 'AIX_PASSWORD_TO_EXPIRE',
  AIX_PASSWORD_EXPIRED = 'AIX_PASSWORD_EXPIRED',
  SSH_KEY_CHANGED = 'SSH_KEY_CHANGED',
  FILE_READ_ONLY = 'FILE_READ_ONLY',
  DBMS_NOT_AVAILABLE = 'DBMS_NOT_AVAILABLE',
}

const ERROR_STRINGS: Partial<Record<SessionError, string>> = {
  [SessionError.AIX_LOGIN_WRONG]: 'AIX Login information is incorrect!',
  [SessionError.AIX_PASSWORD_TO_EXPIRE]: 'AIX password due to expire.',
  [SessionError.AIX_PASSWORD_EXPIRED]: 'AIX password expired.',
  [SessionError.ALREADY_CONNECTED]: 'Symitar Session is already connected.',
  [SessionError.ARGUMENT_ERROR]: 'Invalid File Argument!',
  [SessionError.CONSOLE_BLOCKED]: 'This console has been blocked!',
  [SessionError.FILENAME_TOO_LONG]: 'Filename is too long!',
  [SessionError.INPUT_ERROR]: 'Input Error was detected.',
  [SessionError.INVALID_FILE_TYPE]: 'Invalid File Type.',
  [SessionError.INVALID_QUEUE]: 'Invalid Queue.',
  [SessionError.IO_ERROR]: 'I/O Error.',
  [SessionError.IP_NOT_ALLOWED]: 'Logins not allowed from host.',
  [SessionError.NONE]: 'No Session Error',
  [SessionError.NOT_CONNECTED]: 'Symitar Session is not connected!',
  [SessionError.NOT_WINDOWSLEVEL_3]: 'WINDOWSLEVEL not set to 3.',
  [SessionError.NOT_WINDOWSLEVEL_3_PASS_WILL_EXPIRE]:
    'RepDev is in Symulate mode because your AIX password is due to expire.  Please change it now.',
  [SessionError.NULL_POINTER]: 'Null Pointer.',
  [SessionError.PLINK_NOT_FOUND]: 'Plink.exe was not found in the startup directory.',
  [SessionError.SERVER_NOT_FOUND]: 'Server not found, please check network connections',
  [SessionError.SYM_INVALID]: 'Specified SYM is invalid.',
  [SessionError.USERID_INVALID]: 'Invalid User ID/Password',
  [SessionError.USERID_PASSWORD_CHANGE]: 'User Password change required.',
  [SessionError.INCOMPATIBLE_REVISION]: 'Incompatible Revison',
  [SessionError.DBMS_NOT_AVAILABLE]: 'DBMS not available.  Connection refused.',
  [SessionError.UNDEFINED_ERROR]: 'Undefined Error',
  [SessionError.FILE_READ_ONLY]: 'File not saved.  Read Only !!',
};

export function getErrorString(err: SessionError): string {
  return ERROR_STRINGS[err] ?? 'Undefined Session Error!';
}

/** Ported from FileType.java. */
export enum FileType {
  LETTER = 'LETTER',
  REPGEN = 'REPGEN',
  HELP = 'HELP',
  REPORT = 'REPORT',
  DATA = 'DATA',
}

/** Maps a FileType to the protocol "Type" parameter used in File commands. */
export function fileTypeToProtocol(type: FileType): string | undefined {
  switch (type) {
    case FileType.REPGEN:
      return 'RepWriter';
    case FileType.HELP:
      return 'Help';
    case FileType.LETTER:
      return 'Letter';
    case FileType.REPORT:
      return 'Report';
    case FileType.DATA:
      return 'Data';
    default:
      return undefined;
  }
}

/** Ported from ErrorCheckResult.java. */
export enum ErrorCheckType {
  ERROR = 'ERROR',
  WARNING = 'WARNING',
  NO_ERROR = 'NO_ERROR',
  INSTALLED_SUCCESSFULLY = 'INSTALLED_SUCCESSFULLY',
}

export interface ErrorCheckResult {
  file: string;
  errorMessage: string;
  lineNumber: number;
  column: number;
  type: ErrorCheckType;
  installSize?: number;
}

/**
 * Minimal SymitarFile descriptor needed by the protocol layer.
 * The full Java SymitarFile also carries local-file/compare-mode state that
 * belongs in higher layers; the session only needs sym + name + type.
 */
export interface SymitarFile {
  sym: number;
  name: string;
  type: FileType;
}

/**
 * Batch FM target file. Ordinal order matters — it's sent verbatim as the menu
 * selection in runBatchFM (ported from SymitarSession.FMFile).
 */
export enum FMFile {
  ACCOUNT = 0,
  INVENTORY = 1,
  PAYEE = 2,
  GL_ACCOUNT = 3,
  RECIEVED_ITEM = 4,
  PARTICIPANT = 5,
  PARTICIPATION = 6,
  DEALER = 7,
  USER = 8,
  COLLATERAL = 9,
}

/** A print-control report item (ported from PrintItem.java). */
export interface PrintItem {
  title: string;
  seq: number;
  size: number;
  pages: number;
  batchSeq: number;
  date: Date | null;
}

/** A batch sequence reference (ported from Sequence.java). */
export interface Sequence {
  sym: number;
  seq: number;
  date: Date;
}

/** Day-of-year (1-366) for a date, used by PrintItem ordering. */
function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

/**
 * Comparator for PrintItems, ported from PrintItem.compareTo: same day-of-year
 * sorts by batchSeq, otherwise by date.
 */
export function comparePrintItems(a: PrintItem, b: PrintItem): number {
  if (!a.date || !b.date) return 0;
  if (dayOfYear(a.date) === dayOfYear(b.date)) {
    return a.batchSeq < b.batchSeq ? -1 : a.batchSeq > b.batchSeq ? 1 : 0;
  }
  return a.date.getTime() - b.date.getTime();
}

/**
 * Parses Symitar date/time strings, ported from Util.parseDate:
 *   date "MMDDYYYY" (+ optional time as a number padded to 4 digits "HHmm").
 * Returns null on malformed input (matching the Java catch-and-null).
 */
export function parseSymitarDate(dateStr: string, time?: string): Date | null {
  if (!dateStr || dateStr.length < 8) return null;
  const month = parseInt(dateStr.substring(0, 2), 10);
  const day = parseInt(dateStr.substring(2, 4), 10);
  const year = parseInt(dateStr.substring(4, 8), 10);
  if ([month, day, year].some(Number.isNaN)) return null;

  let hh = 0;
  let mm = 0;
  if (time !== undefined && time.trim() !== '') {
    const padded = String(parseInt(time, 10)).padStart(4, '0');
    hh = parseInt(padded.substring(0, 2), 10);
    mm = parseInt(padded.substring(2, 4), 10);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  }
  return new Date(year, month - 1, day, hh, mm);
}
