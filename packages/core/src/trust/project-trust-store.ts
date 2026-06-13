import { z } from 'zod';
import { resolveMissionControlDataDir } from '../memory/data-dir.js';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const projectTrustDecisions = ['trusted', 'denied', 'unknown'] as const;
export type ProjectTrustDecision = (typeof projectTrustDecisions)[number];

const trustRecordSchema = z
    .object({
        status: z.enum(projectTrustDecisions),
        updatedAt: z.string().min(1),
    })
    .strict();

const trustFileSchema = z
    .object({
        version: z.literal(1),
        workspaces: z.record(z.string().min(1), trustRecordSchema),
    })
    .strict();

type TrustFile = z.infer<typeof trustFileSchema>;
type TrustRecord = z.infer<typeof trustRecordSchema>;

export type ProjectTrustLookup = {
    readonly decision: ProjectTrustDecision;
    readonly workspaceRoot: string;
    readonly filePath: string;
    readonly storeState: 'missing' | 'valid' | 'corrupt';
    readonly errorMessage?: string;
};

export type ProjectTrustStoreOptions = {
    readonly dataDir?: string;
    readonly filePath?: string;
    readonly now?: () => string;
    readonly lockRetryDelayMs?: number;
    readonly lockMaxAttempts?: number;
};

type TrustFileReadResult =
    | {
          readonly state: 'missing' | 'valid';
          readonly file: TrustFile;
      }
    | {
          readonly state: 'corrupt';
          readonly errorMessage: string;
      };

const emptyTrustFile = {
    version: 1,
    workspaces: {},
} satisfies TrustFile;

export class ProjectTrustStore {
    readonly filePath: string;
    private readonly now: () => string;
    private readonly lockRetryDelayMs: number;
    private readonly lockMaxAttempts: number;

    constructor(options: ProjectTrustStoreOptions = {}) {
        const dataDir = options.dataDir ?? resolveMissionControlDataDir();
        this.filePath = options.filePath ?? join(dataDir, 'trust', 'projects.json');
        this.now = options.now ?? (() => new Date().toISOString());
        this.lockRetryDelayMs = options.lockRetryDelayMs ?? 10;
        this.lockMaxAttempts = options.lockMaxAttempts ?? 80;
    }

    async getDecision(workspaceRoot: string): Promise<ProjectTrustLookup> {
        const normalizedRoot = await normalizeWorkspaceRoot(workspaceRoot);
        const read = await readTrustFile(this.filePath);
        if (read.state === 'corrupt') {
            return trustLookup('unknown', normalizedRoot, this.filePath, read.state, read.errorMessage);
        }
        const record = read.file.workspaces[normalizedRoot];
        return trustLookup(record?.status ?? 'unknown', normalizedRoot, this.filePath, read.state);
    }

    async setDecision(workspaceRoot: string, decision: ProjectTrustDecision): Promise<ProjectTrustLookup> {
        const normalizedRoot = await normalizeWorkspaceRoot(workspaceRoot);
        await withTrustFileLock(this.filePath, this.lockMaxAttempts, this.lockRetryDelayMs, async () => {
            const read = await readTrustFile(this.filePath);
            if (read.state === 'corrupt') {
                throw new ProjectTrustStoreError(
                    'corrupt_store',
                    `Cannot update corrupt trust store ${this.filePath}: ${read.errorMessage}`,
                );
            }
            await writeTrustFile(this.filePath, updateTrustFile(read.file, normalizedRoot, decision, this.now()));
        });
        return this.getDecision(normalizedRoot);
    }

    async resetDecision(workspaceRoot: string): Promise<ProjectTrustLookup> {
        return this.setDecision(workspaceRoot, 'unknown');
    }
}

export async function normalizeWorkspaceRoot(workspaceRoot: string): Promise<string> {
    return realpath(resolve(workspaceRoot));
}

function trustLookup(
    decision: ProjectTrustDecision,
    workspaceRoot: string,
    filePath: string,
    storeState: ProjectTrustLookup['storeState'],
    errorMessage?: string,
): ProjectTrustLookup {
    return {
        decision,
        workspaceRoot,
        filePath,
        storeState,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
}

async function readTrustFile(filePath: string): Promise<TrustFileReadResult> {
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isNodeError(error, 'ENOENT')) {
            return { state: 'missing', file: emptyTrustFile };
        }
        return { state: 'corrupt', errorMessage: errorMessage(error) };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch (error: unknown) {
        return { state: 'corrupt', errorMessage: errorMessage(error) };
    }

    const result = trustFileSchema.safeParse(parsed);
    if (!result.success) {
        return {
            state: 'corrupt',
            errorMessage: result.error.issues.map((issue) => issue.message).join('; '),
        };
    }
    return { state: 'valid', file: result.data };
}

function updateTrustFile(
    file: TrustFile,
    workspaceRoot: string,
    decision: ProjectTrustDecision,
    updatedAt: string,
): TrustFile {
    const retainedEntries = Object.entries(file.workspaces).filter(([root]) => root !== workspaceRoot);
    const workspaces: Record<string, TrustRecord> = Object.fromEntries(retainedEntries);
    if (decision !== 'unknown') {
        workspaces[workspaceRoot] = { status: decision, updatedAt };
    }
    return { version: 1, workspaces };
}

async function writeTrustFile(filePath: string, file: TrustFile): Promise<void> {
    const sortedFile = trustFileSchema.parse({
        version: 1,
        workspaces: Object.fromEntries(
            Object.entries(file.workspaces).sort(([left], [right]) => left.localeCompare(right)),
        ),
    });
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await ensureDirectory(dirname(filePath));
    await writeFile(tempPath, `${JSON.stringify(sortedFile, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, filePath);
    await rm(tempPath, { force: true });
}

async function withTrustFileLock<T>(
    filePath: string,
    maxAttempts: number,
    retryDelayMs: number,
    operation: () => Promise<T>,
): Promise<T> {
    const lockPath = `${filePath}.lock`;
    await ensureDirectory(dirname(filePath));
    const release = await acquireLock(lockPath, maxAttempts, retryDelayMs);
    try {
        return await operation();
    } finally {
        await release();
    }
}

async function ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
}

async function acquireLock(lockPath: string, maxAttempts: number, retryDelayMs: number): Promise<() => Promise<void>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            const handle = await open(lockPath, 'wx');
            await handle.writeFile(`${process.pid}\n`, 'utf8');
            return async () => {
                await handle.close();
                await rm(lockPath, { force: true });
            };
        } catch (error: unknown) {
            if (!isNodeError(error, 'EEXIST')) {
                throw error;
            }
            lastError = error;
            await delay(retryDelayMs);
        }
    }
    throw new ProjectTrustStoreError(
        'lock_timeout',
        `Timed out acquiring trust store lock: ${errorMessage(lastError)}`,
    );
}

export class ProjectTrustStoreError extends Error {
    constructor(
        readonly code: 'corrupt_store' | 'lock_timeout',
        message: string,
    ) {
        super(message);
        this.name = 'ProjectTrustStoreError';
    }
}

function isNodeError(error: unknown, code: string): error is { readonly code: string } {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
