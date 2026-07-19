import type { ChatInputEvent } from '../apps/cli/src/commands/interactive-chat-io.js';
import type { ProviderAuthStore } from '../packages/core/src/index.js';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve: (() => void) | undefined;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    if (resolve === undefined) {
        throw new Error('deferred initialization failed');
    }
    return { promise, resolve };
}

export function emptyAuthStore(authFilePath: string): ProviderAuthStore {
    return {
        authFilePath,
        readAuthFile: async () => ({ $schema: 'https://mission-control.dev/auth.schema.json', credentials: {} }),
        saveCredential: async () => undefined,
        updateOAuthCredential: async () => undefined,
        setDefaultSelection: async () => undefined,
        deleteCredential: async () => undefined,
        listCredentialSummaries: async () => [],
        getDefaultSelection: async () => undefined,
        getModelRoles: async () => ({}),
        setModelRole: async () => undefined,
        clearModelRole: async () => undefined,
    };
}

export function scriptedInput(
    events: readonly ChatInputEvent[],
    waits: readonly { readonly beforeIndex: number; readonly until: Promise<void> }[] = [],
) {
    let index = 0;
    return {
        read: async () => {
            const wait = waits.find((candidate) => candidate.beforeIndex === index);
            if (wait !== undefined) {
                await wait.until;
            }
            const event = events[index] ?? { type: 'interrupt' as const };
            index += 1;
            return event;
        },
        close: () => undefined,
    };
}

export function bufferedOutput() {
    const chunks: string[] = [];
    return {
        output: {
            write(text: string) {
                chunks.push(text);
            },
            getOutput() {
                return chunks.join('');
            },
        },
    };
}

export async function initializeGitWorkspace(workspaceRoot: string): Promise<void> {
    await execFileAsync('git', ['init'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: workspaceRoot });
    await execFileAsync('git', ['config', 'user.name', 'Smoke Test'], { cwd: workspaceRoot });
}

export async function tempRoot(prefix: string, tempRoots: string[]): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}
