import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CRASH_DIR_NAME,
    type CrashKind,
    type CrashRecord,
    crashGuardActiveSession,
    formatCrashRecord,
    installCrashGuard,
    registerCrashGuardActiveSession,
    resetCrashGuardForTests,
} from './crash-guard';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoots: string[] = [];

afterEach(() => {
    for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
    registerCrashGuardActiveSession(undefined);
    resetCrashGuardForTests();
});

class TestExit extends Error {
    constructor() {
        super('process.exit');
    }
}

function freshDataDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'mctrl-crash-guard-'));
    tmpRoots.push(root);
    return root;
}

describe('crash guard formatCrashRecord', () => {
    it('renders a human-readable record with a JSON tail and the active session id', () => {
        const record: CrashRecord = {
            kind: 'unhandledRejection',
            timestamp: '2026-07-25T17:20:43.787Z',
            pid: 385911,
            nodeVersion: 'v20.0.0',
            platform: 'linux',
            cwd: '/home/noiz/projects/mission-control',
            activeSessionId: 'session_1784999391325',
            name: 'Error',
            message: 'fence teardown failed',
            stack: 'Error: fence teardown failed\n    at tick',
        };
        const text = formatCrashRecord(record);
        expect(text).toContain('mission-control crash: unhandledRejection');
        expect(text).toContain('session: session_1784999391325');
        expect(text).toContain('Error: fence teardown failed');
        expect(text).toContain('--- json ---');
        const jsonLine = text.split('\n').find((line) => line.startsWith('{'));
        expect(jsonLine).toBeDefined();
        expect(JSON.parse(jsonLine ?? '{}')).toMatchObject({
            kind: 'unhandledRejection',
            activeSessionId: 'session_1784999391325',
            pid: 385911,
        });
    });
});

describe('crash guard installCrashGuard', () => {
    it('writes a crash record file and exits when an escaping rejection is reported', async () => {
        const dataDir = freshDataDir();
        registerCrashGuardActiveSession('session_dying');
        let handler: ((kind: CrashKind, reason: unknown) => void) | undefined;
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new TestExit();
        });
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        installCrashGuard({
            dataDir,
            installListeners: (h) => {
                handler = h;
            },
        });
        // Idempotent: a second install must not rebind.
        installCrashGuard({ dataDir, installListeners: () => undefined });

        expect(handler).toBeDefined();
        expect(() => handler?.('unhandledRejection', new Error('lease renewer exploded'))).toThrow(TestExit);

        const dir = join(dataDir, CRASH_DIR_NAME);
        const files = listFiles(dir);
        expect(files.length).toBe(1);
        const contents = readFileSync(join(dir, files[0] ?? ''), 'utf8');
        expect(contents).toContain('unhandledRejection');
        expect(contents).toContain('session: session_dying');
        expect(contents).toContain('lease renewer exploded');
        expect(files[0]).toContain('unhandledRejection');
        exit.mockRestore();
        stderr.mockRestore();
    });

    it('flushes the optional prompt draft global before emergency restore and exit', () => {
        const dataDir = freshDataDir();
        let handler: ((kind: CrashKind, reason: unknown) => void) | undefined;
        const order: string[] = [];
        const host = globalThis as typeof globalThis & {
            __mcEmergencyTerminalRestore?: () => void;
            __mcFlushPromptDraft?: () => void;
        };
        const previousRestore = host.__mcEmergencyTerminalRestore;
        const previousFlush = host.__mcFlushPromptDraft;
        host.__mcFlushPromptDraft = () => {
            order.push('flush');
        };
        host.__mcEmergencyTerminalRestore = () => {
            order.push('restore');
        };
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new TestExit();
        });
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            installCrashGuard({
                dataDir,
                installListeners: (h) => {
                    handler = h;
                },
            });
            expect(() => handler?.('uncaughtException', new Error('draft crash'))).toThrow(TestExit);
            expect(order).toEqual(['flush', 'restore']);
        } finally {
            if (previousRestore === undefined) Reflect.deleteProperty(host, '__mcEmergencyTerminalRestore');
            else host.__mcEmergencyTerminalRestore = previousRestore;
            if (previousFlush === undefined) Reflect.deleteProperty(host, '__mcFlushPromptDraft');
            else host.__mcFlushPromptDraft = previousFlush;
            exit.mockRestore();
            stderr.mockRestore();
        }
    });

    it('invokes the optional emergency terminal restore global before exit', () => {
        const dataDir = freshDataDir();
        let handler: ((kind: CrashKind, reason: unknown) => void) | undefined;
        const restore = vi.fn();
        const host = globalThis as typeof globalThis & { __mcEmergencyTerminalRestore?: () => void };
        const previous = host.__mcEmergencyTerminalRestore;
        host.__mcEmergencyTerminalRestore = restore;
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new TestExit();
        });
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        try {
            installCrashGuard({
                dataDir,
                installListeners: (h) => {
                    handler = h;
                },
            });
            expect(() => handler?.('uncaughtException', new Error('tui blew up'))).toThrow(TestExit);
            expect(restore).toHaveBeenCalledTimes(1);
        } finally {
            if (previous === undefined) {
                Reflect.deleteProperty(host, '__mcEmergencyTerminalRestore');
            } else {
                host.__mcEmergencyTerminalRestore = previous;
            }
            exit.mockRestore();
            stderr.mockRestore();
        }
    });

    it('survives an unwritable data dir without throwing from the handler', () => {
        let handler: ((kind: CrashKind, reason: unknown) => void) | undefined;
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new TestExit();
        });
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        installCrashGuard({
            // A path under a fresh temp dir + missing parent makes mkdirSync fail gracefully.
            dataDir: join(freshDataDir(), 'not-a-dir', 'sub'),
            installListeners: (h) => {
                handler = h;
            },
        });
        expect(() => handler?.('uncaughtException', new Error('boom'))).toThrow(TestExit);
        expect(crashGuardActiveSession()).toBeUndefined();
        exit.mockRestore();
        stderr.mockRestore();
    });
});

function listFiles(dir: string): string[] {
    try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) return [];
        return readdirSync(dir).filter((name) => name.endsWith('.log'));
    } catch {
        return [];
    }
}
