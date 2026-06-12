import {
    SESSION_INDEX_FILE_VERSION,
    type SessionIndexFile,
    SessionIndexFileSchema,
} from './session-index-file-format.js';
import { deriveSessionIndexRecords } from './session-index-projection.js';
import type {
    SessionIndexApprovalRecord,
    SessionIndexDiagnostic,
    SessionIndexProviderFailureRecord,
    SessionIndexRebuildResult,
    SessionIndexRecord,
    SessionIndexRunRecord,
    SessionIndexSessionRecord,
    SessionIndexStore,
    SessionIndexToolRecord,
} from './session-index-types.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const indexWriteQueues = new Map<string, Promise<void>>();
let tempPathCounter = 0;

export function createFileSessionIndexStore(input: { readonly indexPath: string }): SessionIndexStore {
    return new FileSessionIndexStore(input.indexPath);
}

export async function rebuildSessionIndexFromJsonl(input: {
    readonly store: SessionIndexStore;
    readonly sessionId: string;
    readonly filePath: string;
    readonly contents: string;
}): Promise<SessionIndexRebuildResult> {
    const projection = deriveSessionIndexRecords(input);
    await input.store.replaceSessionIndex({
        sessionId: input.sessionId,
        records: projection.records,
        diagnostics: projection.diagnostics,
    });
    return {
        sessionId: input.sessionId,
        indexedRecords: projection.records.length,
        diagnostics: projection.diagnostics,
    };
}

class FileSessionIndexStore implements SessionIndexStore {
    constructor(private readonly indexPath: string) {}

    async replaceSessionIndex(input: {
        readonly sessionId: string;
        readonly records: readonly SessionIndexRecord[];
        readonly diagnostics: readonly SessionIndexDiagnostic[];
    }): Promise<void> {
        await enqueueIndexWrite(this.indexPath, async () => {
            const current = await this.readState();
            await this.writeState({
                version: SESSION_INDEX_FILE_VERSION,
                records: [...recordsExceptSession(current.records, input.sessionId), ...input.records].sort(
                    compareRecords,
                ),
                diagnostics: [
                    ...current.diagnostics.filter((diagnostic) => diagnostic.sessionId !== input.sessionId),
                    ...input.diagnostics,
                ].sort(compareDiagnostics),
            });
        });
    }

    async listSessions(): Promise<readonly SessionIndexSessionRecord[]> {
        const state = await this.readState();
        return state.records.flatMap(sessionRecord).sort(compareSessionRecords);
    }

    async getSession(sessionId: string): Promise<SessionIndexSessionRecord | null> {
        const sessions = await this.listSessions();
        return sessions.find((session) => session.sessionId === sessionId) ?? null;
    }

    async getRuns(sessionId: string): Promise<readonly SessionIndexRunRecord[]> {
        const state = await this.readState();
        return state.records.flatMap(runRecord).filter((record) => record.sessionId === sessionId);
    }

    async getApprovals(sessionId: string): Promise<readonly SessionIndexApprovalRecord[]> {
        const state = await this.readState();
        return state.records.flatMap(approvalRecord).filter((record) => record.sessionId === sessionId);
    }

    async getTools(sessionId: string): Promise<readonly SessionIndexToolRecord[]> {
        const state = await this.readState();
        return state.records.flatMap(toolRecord).filter((record) => record.sessionId === sessionId);
    }

    async getProviderFailures(sessionId: string): Promise<readonly SessionIndexProviderFailureRecord[]> {
        const state = await this.readState();
        return state.records.flatMap(providerFailureRecord).filter((record) => record.sessionId === sessionId);
    }

    async getDiagnostics(sessionId: string): Promise<readonly SessionIndexDiagnostic[]> {
        const state = await this.readState();
        return state.diagnostics.filter((diagnostic) => diagnostic.sessionId === sessionId);
    }

    private async readState(): Promise<SessionIndexFile> {
        try {
            const raw: unknown = JSON.parse(await readFile(this.indexPath, 'utf8'));
            return SessionIndexFileSchema.parse(raw);
        } catch (error: unknown) {
            if (isNodeError(error) && error.code === 'ENOENT') {
                return emptyIndexFile();
            }
            throw error;
        }
    }

    private async writeState(state: SessionIndexFile): Promise<void> {
        await mkdir(dirname(this.indexPath), { recursive: true });
        const tempPath = tempIndexPath(this.indexPath);
        await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await rename(tempPath, this.indexPath);
    }
}

async function enqueueIndexWrite(indexPath: string, write: () => Promise<void>): Promise<void> {
    const previous = indexWriteQueues.get(indexPath) ?? Promise.resolve();
    const result = previous.then(write, write);
    const tracked = result.catch(() => undefined);
    indexWriteQueues.set(indexPath, tracked);
    try {
        await result;
    } finally {
        if (indexWriteQueues.get(indexPath) === tracked) {
            indexWriteQueues.delete(indexPath);
        }
    }
}

function emptyIndexFile(): SessionIndexFile {
    return {
        version: SESSION_INDEX_FILE_VERSION,
        records: [],
        diagnostics: [],
    };
}

function recordsExceptSession(
    records: readonly SessionIndexRecord[],
    sessionId: string,
): readonly SessionIndexRecord[] {
    return records.filter((record) => record.sessionId !== sessionId);
}

function sessionRecord(record: SessionIndexRecord): readonly SessionIndexSessionRecord[] {
    switch (record.kind) {
        case 'session':
            return [record];
        case 'approval':
        case 'provider_failure':
        case 'run':
        case 'tool':
            return [];
        default:
            return assertNever(record);
    }
}

function runRecord(record: SessionIndexRecord): readonly SessionIndexRunRecord[] {
    switch (record.kind) {
        case 'run':
            return [record];
        case 'approval':
        case 'provider_failure':
        case 'session':
        case 'tool':
            return [];
        default:
            return assertNever(record);
    }
}

function approvalRecord(record: SessionIndexRecord): readonly SessionIndexApprovalRecord[] {
    switch (record.kind) {
        case 'approval':
            return [record];
        case 'provider_failure':
        case 'run':
        case 'session':
        case 'tool':
            return [];
        default:
            return assertNever(record);
    }
}

function toolRecord(record: SessionIndexRecord): readonly SessionIndexToolRecord[] {
    switch (record.kind) {
        case 'tool':
            return [record];
        case 'approval':
        case 'provider_failure':
        case 'run':
        case 'session':
            return [];
        default:
            return assertNever(record);
    }
}

function providerFailureRecord(record: SessionIndexRecord): readonly SessionIndexProviderFailureRecord[] {
    switch (record.kind) {
        case 'provider_failure':
            return [record];
        case 'approval':
        case 'run':
        case 'session':
        case 'tool':
            return [];
        default:
            return assertNever(record);
    }
}

function compareRecords(left: SessionIndexRecord, right: SessionIndexRecord): number {
    const sessionOrder = left.sessionId.localeCompare(right.sessionId);
    if (sessionOrder !== 0) {
        return sessionOrder;
    }
    if (left.kind === 'run' && right.kind === 'run') {
        return compareRunRecords(left, right);
    }
    return recordSortKey(left).localeCompare(recordSortKey(right));
}

function compareRunRecords(left: SessionIndexRunRecord, right: SessionIndexRunRecord): number {
    return left.sequence - right.sequence || left.eventId.localeCompare(right.eventId);
}

function compareDiagnostics(left: SessionIndexDiagnostic, right: SessionIndexDiagnostic): number {
    return `${left.sessionId}:${left.filePath}:${left.code}:${left.lineNumber ?? 0}`.localeCompare(
        `${right.sessionId}:${right.filePath}:${right.code}:${right.lineNumber ?? 0}`,
    );
}

function compareSessionRecords(left: SessionIndexSessionRecord, right: SessionIndexSessionRecord): number {
    return left.updatedAt.localeCompare(right.updatedAt) || left.sessionId.localeCompare(right.sessionId);
}

function recordSortKey(record: SessionIndexRecord): string {
    switch (record.kind) {
        case 'approval':
            return `${record.sessionId}:approval:${record.approvalId}`;
        case 'provider_failure':
            return `${record.sessionId}:provider_failure:${record.eventId}`;
        case 'run':
            return `${record.sessionId}:run:${record.sequence}:${record.eventId}`;
        case 'session':
            return `${record.sessionId}:session`;
        case 'tool':
            return `${record.sessionId}:tool:${record.toolId}`;
        default:
            return assertNever(record);
    }
}

function tempIndexPath(indexPath: string): string {
    tempPathCounter = (tempPathCounter + 1) % Number.MAX_SAFE_INTEGER;
    return `${indexPath}.${process.pid}.${tempPathCounter}.tmp`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}

function assertNever(value: never): never {
    throw new Error(`Unhandled session index file record variant: ${JSON.stringify(value)}`);
}
