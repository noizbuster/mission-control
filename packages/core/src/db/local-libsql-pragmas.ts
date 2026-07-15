import type { Client, ResultSet, Value } from '@libsql/client';
import { z } from 'zod';

export const LOCAL_DB_BUSY_TIMEOUT_MS = 5000;

export const localDbInitializationErrorCodes = ['wal_refused', 'unexpected_pragma_value'] as const;
export type LocalDbInitializationErrorCode = (typeof localDbInitializationErrorCodes)[number];
export type LocalDbPragma = 'journal_mode' | 'synchronous' | 'busy_timeout' | 'foreign_keys';
export type LocalDbPragmaExpected = 'wal' | 1 | typeof LOCAL_DB_BUSY_TIMEOUT_MS;
export type LocalDbPragmaActual = Value | undefined;

export class LocalDbInitializationError extends Error {
    readonly name = 'LocalDbInitializationError';

    constructor(
        readonly code: LocalDbInitializationErrorCode,
        readonly pragma: LocalDbPragma,
        readonly expected: LocalDbPragmaExpected,
        readonly actual: LocalDbPragmaActual,
    ) {
        super(`Local libSQL ${pragma} initialization expected ${String(expected)}, received ${String(actual)}`);
    }
}

const journalModeSchema = z.string();
const numericPragmaSchema = z.number().int();

type NumericPragmaExpectation = {
    readonly pragma: Exclude<LocalDbPragma, 'journal_mode'>;
    readonly column: 'synchronous' | 'timeout' | 'foreign_keys';
    readonly expected: 1 | typeof LOCAL_DB_BUSY_TIMEOUT_MS;
};

export async function initializeLocalLibsqlForeignKeys(client: Client): Promise<void> {
    await client.execute('PRAGMA foreign_keys=ON');
    requireNumericPragma(await client.execute('PRAGMA foreign_keys'), {
        pragma: 'foreign_keys',
        column: 'foreign_keys',
        expected: 1,
    });
}

export async function initializeLocalLibsqlFilePragmas(client: Client): Promise<void> {
    const requestedJournalMode = await client.execute('PRAGMA journal_mode=WAL');
    requireJournalMode(requestedJournalMode, 'wal_refused');
    await client.execute('PRAGMA synchronous=NORMAL');

    requireJournalMode(await client.execute('PRAGMA journal_mode'), 'unexpected_pragma_value');
    requireNumericPragma(await client.execute('PRAGMA synchronous'), {
        pragma: 'synchronous',
        column: 'synchronous',
        expected: 1,
    });
    requireNumericPragma(await client.execute('PRAGMA busy_timeout'), {
        pragma: 'busy_timeout',
        column: 'timeout',
        expected: LOCAL_DB_BUSY_TIMEOUT_MS,
    });
}

function requireJournalMode(result: ResultSet, code: LocalDbInitializationErrorCode): void {
    const actual = result.rows[0]?.[0];
    const parsed = journalModeSchema.safeParse(actual);
    if (!parsed.success || parsed.data !== 'wal') {
        throw new LocalDbInitializationError(code, 'journal_mode', 'wal', actual);
    }
}

function requireNumericPragma(result: ResultSet, expectation: NumericPragmaExpectation): void {
    const actual = result.rows[0]?.[expectation.column];
    const parsed = numericPragmaSchema.safeParse(actual);
    if (!parsed.success || parsed.data !== expectation.expected) {
        throw new LocalDbInitializationError(
            'unexpected_pragma_value',
            expectation.pragma,
            expectation.expected,
            actual,
        );
    }
}
