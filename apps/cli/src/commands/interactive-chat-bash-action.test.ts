import { ProjectTrustStore } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseChatLine } from './chat-commands.js';
import type { CodingActionContext } from './interactive-chat-actions.js';
import { runBashAction, runBashDisplayOnlyAction } from './interactive-chat-bash-action.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type CapturingOutput = {
    readonly write: (text: string) => void;
    readonly text: () => string;
};

function createCapturingOutput(): CapturingOutput {
    const chunks: string[] = [];
    return {
        write: (text: string) => {
            chunks.push(text);
        },
        text: () => chunks.join(''),
    };
}

const baseSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };

function createCodingContext(workspaceRoot: string | undefined): CodingActionContext {
    return {
        provider: undefined,
        sessionId: undefined,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : { workspaceRoot: undefined }),
        commandExecutor: undefined,
        emitEvent: undefined,
        observeStoredEvent: undefined,
        nextTurnId: () => 'turn_bash_test',
        sessionStore: undefined,
        activeTurn: undefined,
    };
}

function createCapturingSubmitter(): {
    readonly submitter: (prompt: string) => Promise<ActiveCodingAgentTurn | undefined>;
    readonly submitted: () => readonly string[];
} {
    const prompts: string[] = [];
    return {
        submitter: async (prompt: string) => {
            prompts.push(prompt);
            return undefined;
        },
        submitted: () => prompts,
    };
}

describe('bash command parser', () => {
    it('parses !ls as a bash action', () => {
        expect(parseChatLine('!ls')).toEqual({ kind: 'bash', command: 'ls' });
    });

    it('parses !!ls as a bash-display-only action', () => {
        expect(parseChatLine('!!ls')).toEqual({ kind: 'bash-display-only', command: 'ls' });
    });

    it('preserves the full command including flags for !ls -la', () => {
        expect(parseChatLine('!ls -la')).toEqual({ kind: 'bash', command: 'ls -la' });
    });

    it('preserves quotes and spaces in the command', () => {
        expect(parseChatLine('! echo "hello world"')).toEqual({
            kind: 'bash',
            command: 'echo "hello world"',
        });
    });

    it('does not treat a normal prompt as a bash action', () => {
        expect(parseChatLine('hello')).toEqual({ kind: 'prompt', prompt: 'hello' });
    });

    it('does not treat a slash command as a bash action', () => {
        expect(parseChatLine('/exit')).toEqual({ kind: 'exit' });
    });

    it('rejects a bare ! with no command', () => {
        expect(parseChatLine('!')).toEqual({ kind: 'invalid', message: 'Bash command is empty' });
    });

    it('rejects a bare !! with no command', () => {
        expect(parseChatLine('!!')).toEqual({ kind: 'invalid', message: 'Bash command is empty' });
    });

    it('still routes dollar-prefixed input to skill invocation', () => {
        expect(parseChatLine('$planner')).toEqual({ kind: 'skill', name: 'planner', instruction: '' });
    });
});

describe('runBashAction trust gating', () => {
    const envKey = 'MCTRL_DATA_DIR';
    let originalDataDir: string | undefined;
    let workspace: string;
    let dataDir: string;

    beforeEach(() => {
        originalDataDir = process.env[envKey];
        workspace = mkdtempSync(join(tmpdir(), 'mctrl-bash-ws-'));
        dataDir = mkdtempSync(join(tmpdir(), 'mctrl-bash-data-'));
        process.env[envKey] = dataDir;
    });

    afterEach(() => {
        if (originalDataDir === undefined) {
            delete process.env[envKey];
        } else {
            process.env[envKey] = originalDataDir;
        }
        rmSync(workspace, { recursive: true, force: true });
        rmSync(dataDir, { recursive: true, force: true });
    });

    it('writes a trust error and does NOT execute on an untrusted workspace', async () => {
        const marker = join(workspace, 'should-not-exist.txt');
        const output = createCapturingOutput();
        const { submitter, submitted } = createCapturingSubmitter();

        const result = await runBashAction(
            output,
            baseSelection,
            createCodingContext(workspace),
            { kind: 'bash', command: `touch ${marker}` },
            submitter,
        );

        expect(output.text()).toContain('requires a trusted workspace');
        expect(existsSync(marker)).toBe(false);
        expect(submitted()).toHaveLength(0);
        expect(result.modelProviderSelection).toEqual(baseSelection);
    });

    it('writes a workspace error when no workspace root is configured', async () => {
        const output = createCapturingOutput();
        const { submitter, submitted } = createCapturingSubmitter();

        await runBashAction(
            output,
            baseSelection,
            createCodingContext(undefined),
            { kind: 'bash', command: 'echo hello' },
            submitter,
        );

        expect(output.text()).toContain('requires a workspace');
        expect(submitted()).toHaveLength(0);
    });
});

describe('runBashAction on a trusted workspace', () => {
    const envKey = 'MCTRL_DATA_DIR';
    let originalDataDir: string | undefined;
    let workspace: string;
    let dataDir: string;

    beforeEach(async () => {
        originalDataDir = process.env[envKey];
        workspace = mkdtempSync(join(tmpdir(), 'mctrl-bash-ws-'));
        dataDir = mkdtempSync(join(tmpdir(), 'mctrl-bash-data-'));
        process.env[envKey] = dataDir;
        await new ProjectTrustStore().setDecision(workspace, 'trusted');
    });

    afterEach(() => {
        if (originalDataDir === undefined) {
            delete process.env[envKey];
        } else {
            process.env[envKey] = originalDataDir;
        }
        rmSync(workspace, { recursive: true, force: true });
        rmSync(dataDir, { recursive: true, force: true });
    });

    it('executes the command, formats the output, and submits it as a prompt', async () => {
        const output = createCapturingOutput();
        const { submitter, submitted } = createCapturingSubmitter();

        const result = await runBashAction(
            output,
            baseSelection,
            createCodingContext(workspace),
            { kind: 'bash', command: 'echo hello' },
            submitter,
        );

        const expected = '! echo hello\nhello\n';
        expect(output.text()).toBe(expected);
        expect(submitted()).toEqual([expected]);
        expect(result.activeTurn).toBeUndefined();
    });

    it('merges stderr into the captured output', async () => {
        const output = createCapturingOutput();
        const { submitter } = createCapturingSubmitter();

        await runBashAction(
            output,
            baseSelection,
            createCodingContext(workspace),
            { kind: 'bash', command: 'echo stderr-msg >&2' },
            submitter,
        );

        expect(output.text()).toContain('stderr-msg');
    });

    it('redacts credential-shaped output before display and submission', async () => {
        const output = createCapturingOutput();
        const { submitter, submitted } = createCapturingSubmitter();

        await runBashAction(
            output,
            baseSelection,
            createCodingContext(workspace),
            { kind: 'bash', command: 'echo sk-test1234567' },
            submitter,
        );

        expect(output.text()).toContain('[REDACTED_CREDENTIAL]');
        expect(output.text()).not.toContain('sk-test1234567');
        expect(submitted()[0] ?? '').not.toContain('sk-test1234567');
    });

    it('writes an Error line when the command exits non-zero', async () => {
        const output = createCapturingOutput();
        const { submitter, submitted } = createCapturingSubmitter();

        await runBashAction(
            output,
            baseSelection,
            createCodingContext(workspace),
            { kind: 'bash', command: 'false' },
            submitter,
        );

        expect(output.text()).toBe('Error: command exited with status 1\n');
        expect(submitted()).toHaveLength(0);
    });
});

describe('runBashDisplayOnlyAction', () => {
    const envKey = 'MCTRL_DATA_DIR';
    let originalDataDir: string | undefined;
    let workspace: string;
    let dataDir: string;

    beforeEach(async () => {
        originalDataDir = process.env[envKey];
        workspace = mkdtempSync(join(tmpdir(), 'mctrl-bash-ws-'));
        dataDir = mkdtempSync(join(tmpdir(), 'mctrl-bash-data-'));
        process.env[envKey] = dataDir;
        await new ProjectTrustStore().setDecision(workspace, 'trusted');
    });

    afterEach(() => {
        if (originalDataDir === undefined) {
            delete process.env[envKey];
        } else {
            process.env[envKey] = originalDataDir;
        }
        rmSync(workspace, { recursive: true, force: true });
        rmSync(dataDir, { recursive: true, force: true });
    });

    it('executes and displays output but does NOT accept a prompt submitter', async () => {
        const output = createCapturingOutput();

        const result = await runBashDisplayOnlyAction(output, baseSelection, createCodingContext(workspace), {
            kind: 'bash-display-only',
            command: 'echo hi',
        });

        expect(output.text()).toBe('! echo hi\nhi\n');
        expect(result.activeTurn).toBeUndefined();
    });

    it('still enforces the trust gate', async () => {
        const untrustedWorkspace = mkdtempSync(join(tmpdir(), 'mctrl-bash-untrusted-'));
        try {
            const output = createCapturingOutput();
            await runBashDisplayOnlyAction(output, baseSelection, createCodingContext(untrustedWorkspace), {
                kind: 'bash-display-only',
                command: 'echo hi',
            });
            expect(output.text()).toContain('requires a trusted workspace');
        } finally {
            rmSync(untrustedWorkspace, { recursive: true, force: true });
        }
    });
});
