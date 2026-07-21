import { describe, expect, it } from 'vitest';
import type { TranscriptPart, TranscriptPartStatus } from './transcript-part';
import {
    aggregateToolCallsForMessage,
    countDiffDelta,
    formatChipLabel,
    formatExpandedBreakdown,
    formatInlineSummary,
    isAggregatableToolPart,
    isFailedToolStatus,
    isSuccessfulToolStatus,
    resolveToolDisplayName,
} from './tool-call-aggregation';

const MSG = 'msg-1';
const OTHER = 'msg-2';

function toolPart(input: {
    readonly id: string;
    readonly type?: 'inline-tool' | 'block-tool';
    readonly status?: TranscriptPartStatus;
    readonly messageId?: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
    readonly text?: string;
}): TranscriptPart {
    return {
        id: input.id,
        type: input.type ?? 'inline-tool',
        text: input.text ?? '',
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
        ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
    };
}

function commandPart(input: {
    readonly id: string;
    readonly status?: TranscriptPartStatus;
    readonly messageId?: string;
    readonly toolName?: string;
    readonly exitCode?: number;
    readonly text?: string;
}): TranscriptPart {
    return {
        id: input.id,
        type: 'command',
        text: input.text ?? '',
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    };
}

function subagentPart(input: {
    readonly id: string;
    readonly status?: TranscriptPartStatus;
    readonly messageId?: string;
    readonly agentName?: string;
}): TranscriptPart {
    return {
        id: input.id,
        type: 'subagent',
        text: '',
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
    };
}

function diffPart(input: {
    readonly id: string;
    readonly messageId?: string;
    readonly toolCallId?: string;
    readonly text?: string;
}): TranscriptPart {
    return {
        id: input.id,
        type: 'diff',
        text: input.text ?? '',
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
    };
}

describe('status classifiers', () => {
    it('isSuccessfulToolStatus accepts the locked success set only', () => {
        expect(isSuccessfulToolStatus('completed')).toBe(true);
        expect(isSuccessfulToolStatus('informational')).toBe(true);
        expect(isSuccessfulToolStatus('historical')).toBe(true);
        expect(isSuccessfulToolStatus('background')).toBe(true);
        expect(isSuccessfulToolStatus('failed')).toBe(false);
        expect(isSuccessfulToolStatus('pending')).toBe(false);
        expect(isSuccessfulToolStatus(undefined)).toBe(false);
    });

    it('isFailedToolStatus accepts the locked failed set only', () => {
        expect(isFailedToolStatus('failed')).toBe(true);
        expect(isFailedToolStatus('denied')).toBe(true);
        expect(isFailedToolStatus('interrupted')).toBe(true);
        expect(isFailedToolStatus('cancelled')).toBe(true);
        expect(isFailedToolStatus('completed')).toBe(false);
        expect(isFailedToolStatus('running')).toBe(false);
        expect(isFailedToolStatus(undefined)).toBe(false);
    });
});

describe('isAggregatableToolPart', () => {
    it('accepts inline-tool, block-tool, command, and subagent only', () => {
        expect(isAggregatableToolPart(toolPart({ id: 'a', type: 'inline-tool' }))).toBe(true);
        expect(isAggregatableToolPart(toolPart({ id: 'b', type: 'block-tool' }))).toBe(true);
        expect(isAggregatableToolPart(commandPart({ id: 'c' }))).toBe(true);
        expect(isAggregatableToolPart(subagentPart({ id: 'd' }))).toBe(true);
        expect(isAggregatableToolPart(diffPart({ id: 'e' }))).toBe(false);
        expect(isAggregatableToolPart({ id: 'f', type: 'user', text: 'hi' })).toBe(false);
        expect(isAggregatableToolPart({ id: 'g', type: 'assistant', text: 'ok' })).toBe(false);
    });
});

describe('resolveToolDisplayName', () => {
    it('prefers non-empty toolName', () => {
        expect(resolveToolDisplayName(toolPart({ id: 'a', toolName: 'repo.read' }))).toBe('repo.read');
        expect(resolveToolDisplayName(commandPart({ id: 'b', toolName: 'bash.run' }))).toBe('bash.run');
    });

    it('falls back by type when toolName is missing or empty', () => {
        expect(resolveToolDisplayName(commandPart({ id: 'a' }))).toBe('command');
        expect(resolveToolDisplayName(commandPart({ id: 'b', toolName: '' }))).toBe('command');
        expect(resolveToolDisplayName(subagentPart({ id: 'c', agentName: 'explore' }))).toBe('explore');
        expect(resolveToolDisplayName(subagentPart({ id: 'd' }))).toBe('task');
        expect(resolveToolDisplayName(toolPart({ id: 'e' }))).toBe('<unknown>');
        expect(resolveToolDisplayName(toolPart({ id: 'f', toolName: '' }))).toBe('<unknown>');
    });
});

describe('countDiffDelta', () => {
    it('counts + and - lines and skips +++ / --- meta headers', () => {
        const result = countDiffDelta([
            '--- a/file.ts',
            '+++ b/file.ts',
            '@@ -1,2 +1,3 @@',
            ' context',
            '-removed',
            '+added1',
            '+added2',
        ]);
        expect(result).toEqual({ added: 2, removed: 1 });
    });

    it('returns zeros for empty or non-diff lines', () => {
        expect(countDiffDelta([])).toEqual({ added: 0, removed: 0 });
        expect(countDiffDelta(['Target: foo', ' plain'])).toEqual({ added: 0, removed: 0 });
    });
});

describe('aggregateToolCallsForMessage', () => {
    it('returns empty aggregate for empty parts', () => {
        const agg = aggregateToolCallsForMessage([], MSG);
        expect(agg.totalCount).toBe(0);
        expect(agg.failedCount).toBe(0);
        expect(agg.byToolName.size).toBe(0);
        expect(agg.mutationDeltas.size).toBe(0);
        expect(agg.commandExitCodes.size).toBe(0);
    });

    it('counts a single successful tool', () => {
        const parts = [
            toolPart({
                id: 't1',
                status: 'completed',
                messageId: MSG,
                toolName: 'repo.read',
            }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(agg.totalCount).toBe(1);
        expect(agg.failedCount).toBe(0);
        expect(agg.byToolName.get('repo.read')).toBe(1);
    });

    it('counts mixed success and failed tools', () => {
        const parts = [
            toolPart({ id: 't1', status: 'completed', messageId: MSG, toolName: 'repo.read' }),
            toolPart({ id: 't2', status: 'failed', messageId: MSG, toolName: 'file.edit' }),
            commandPart({ id: 't3', status: 'denied', messageId: MSG, toolName: 'bash.run', exitCode: 1 }),
            toolPart({ id: 't4', status: 'informational', messageId: MSG, toolName: 'repo.list' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(agg.totalCount).toBe(2);
        expect(agg.failedCount).toBe(2);
        expect(agg.byToolName.get('repo.read')).toBe(1);
        expect(agg.byToolName.get('repo.list')).toBe(1);
        expect(agg.byToolName.has('file.edit')).toBe(false);
        expect(agg.byToolName.has('bash.run')).toBe(false);
    });

    it('ignores pending, running, streaming, and undefined status', () => {
        const parts = [
            toolPart({ id: 't1', status: 'pending', messageId: MSG, toolName: 'repo.read' }),
            toolPart({ id: 't2', status: 'running', messageId: MSG, toolName: 'repo.read' }),
            toolPart({ id: 't3', status: 'streaming', messageId: MSG, toolName: 'repo.read' }),
            toolPart({ id: 't4', messageId: MSG, toolName: 'repo.read' }),
            toolPart({ id: 't5', status: 'completed', messageId: MSG, toolName: 'repo.read' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(agg.totalCount).toBe(1);
        expect(agg.failedCount).toBe(0);
    });

    it('ignores parts with a different messageId', () => {
        const parts = [
            toolPart({ id: 't1', status: 'completed', messageId: OTHER, toolName: 'repo.read' }),
            toolPart({ id: 't2', status: 'failed', messageId: OTHER, toolName: 'file.edit' }),
            toolPart({ id: 't3', status: 'completed', messageId: MSG, toolName: 'repo.list' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(agg.totalCount).toBe(1);
        expect(agg.failedCount).toBe(0);
        expect(agg.byToolName.get('repo.list')).toBe(1);
        expect(agg.byToolName.has('repo.read')).toBe(false);
    });

    it('does not count diff satellites toward totals or byToolName', () => {
        const parts = [
            toolPart({
                id: 't1',
                status: 'completed',
                messageId: MSG,
                toolName: 'file.edit',
                toolCallId: 'tc-1',
                text: 'Edit preview',
            }),
            diffPart({
                id: 'd1',
                messageId: MSG,
                toolCallId: 'tc-1',
                text: '-old\n+new\n',
            }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(agg.totalCount).toBe(1);
        expect(agg.byToolName.size).toBe(1);
        expect(agg.byToolName.get('file.edit')).toBe(1);
    });

    it('computes mutation delta from successful mutation tool text', () => {
        const parts = [
            toolPart({
                id: 't1',
                status: 'completed',
                messageId: MSG,
                toolName: 'file.edit',
                text: '--- a/x\n+++ b/x\n-old\n+new1\n+new2\n',
            }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(agg.mutationDeltas.get('file.edit')).toEqual({ added: 2, removed: 1 });
    });

    it('falls back to linked diff parts when mutation text has zero delta', () => {
        const parts = [
            toolPart({
                id: 't1',
                status: 'completed',
                messageId: MSG,
                toolName: 'file.patch',
                toolCallId: 'tc-edit',
                text: 'Target: src/a.ts',
            }),
            diffPart({
                id: 'd1',
                messageId: MSG,
                toolCallId: 'tc-edit',
                text: '-a\n-b\n+c\n',
            }),
            diffPart({
                id: 'd2',
                messageId: MSG,
                toolCallId: 'tc-edit',
                text: '+d\n',
            }),
            diffPart({
                id: 'd-other',
                messageId: MSG,
                toolCallId: 'other',
                text: '+ignored\n',
            }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(agg.mutationDeltas.get('file.patch')).toEqual({ added: 2, removed: 2 });
    });

    it('records distinct sorted exit codes for command parts under display name', () => {
        const parts = [
            commandPart({
                id: 'c1',
                status: 'completed',
                messageId: MSG,
                toolName: 'bash.run',
                exitCode: 1,
            }),
            commandPart({
                id: 'c2',
                status: 'failed',
                messageId: MSG,
                toolName: 'bash.run',
                exitCode: 0,
            }),
            commandPart({
                id: 'c3',
                status: 'completed',
                messageId: MSG,
                toolName: 'bash.run',
                exitCode: 1,
            }),
            commandPart({
                id: 'c4',
                status: 'completed',
                messageId: MSG,
                exitCode: 2,
            }),
            commandPart({
                id: 'c5',
                status: 'completed',
                messageId: MSG,
                toolName: 'bash.run',
            }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(agg.commandExitCodes.get('bash.run')).toEqual([0, 1]);
        expect(agg.commandExitCodes.get('command')).toEqual([2]);
        expect(agg.totalCount).toBe(4);
        expect(agg.failedCount).toBe(1);
    });

    it('preserves first-seen order in byToolName', () => {
        const parts = [
            toolPart({ id: 't1', status: 'completed', messageId: MSG, toolName: 'grep' }),
            toolPart({ id: 't2', status: 'completed', messageId: MSG, toolName: 'read' }),
            toolPart({ id: 't3', status: 'completed', messageId: MSG, toolName: 'grep' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect([...agg.byToolName.keys()]).toEqual(['grep', 'read']);
        expect(agg.byToolName.get('grep')).toBe(2);
    });
});

describe('formatInlineSummary', () => {
    it('returns empty string when totalCount is 0', () => {
        const empty = aggregateToolCallsForMessage([], MSG);
        expect(formatInlineSummary(empty)).toBe('');

        const failedOnly = aggregateToolCallsForMessage(
            [toolPart({ id: 't1', status: 'failed', messageId: MSG, toolName: 'file.edit' })],
            MSG,
        );
        expect(formatInlineSummary(failedOnly)).toBe('');
    });

    it('joins success names in first-seen order with middle dots', () => {
        const parts = [
            toolPart({ id: 't1', status: 'completed', messageId: MSG, toolName: 'read' }),
            toolPart({ id: 't2', status: 'completed', messageId: MSG, toolName: 'grep' }),
            toolPart({ id: 't3', status: 'completed', messageId: MSG, toolName: 'read' }),
            toolPart({ id: 't4', status: 'failed', messageId: MSG, toolName: 'write' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(formatInlineSummary(agg)).toBe('read ×2 · grep ×1');
    });
});

describe('formatChipLabel', () => {
    it('returns empty when both counts are zero', () => {
        expect(formatChipLabel(aggregateToolCallsForMessage([], MSG), false)).toBe('');
    });

    it('formats success-only collapsed and expanded chips', () => {
        const parts = [
            toolPart({ id: 't1', status: 'completed', messageId: MSG, toolName: 'read' }),
            toolPart({ id: 't2', status: 'completed', messageId: MSG, toolName: 'grep' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(formatChipLabel(agg, false)).toBe('2 tools · [+]');
        expect(formatChipLabel(agg, true)).toBe('2 tools · [-]');
    });

    it('formats failed-only and mixed chips', () => {
        const failedOnly = aggregateToolCallsForMessage(
            [toolPart({ id: 't1', status: 'failed', messageId: MSG, toolName: 'edit' })],
            MSG,
        );
        expect(formatChipLabel(failedOnly, false)).toBe('1 failed · [+]');
        expect(formatChipLabel(failedOnly, true)).toBe('1 failed · [-]');

        const mixed = aggregateToolCallsForMessage(
            [
                toolPart({ id: 't1', status: 'completed', messageId: MSG, toolName: 'read' }),
                toolPart({ id: 't2', status: 'denied', messageId: MSG, toolName: 'bash.run' }),
                toolPart({ id: 't3', status: 'cancelled', messageId: MSG, toolName: 'write' }),
            ],
            MSG,
        );
        expect(formatChipLabel(mixed, false)).toBe('1 tools · 2 failed · [+]');
        expect(formatChipLabel(mixed, true)).toBe('1 tools · 2 failed · [-]');
    });
});

describe('formatExpandedBreakdown', () => {
    it('emits one line per success name with optional delta and exit codes', () => {
        const parts = [
            toolPart({
                id: 't1',
                status: 'completed',
                messageId: MSG,
                toolName: 'file.edit',
                text: '-a\n+b\n+c\n',
            }),
            toolPart({ id: 't2', status: 'completed', messageId: MSG, toolName: 'repo.read' }),
            commandPart({
                id: 'c1',
                status: 'completed',
                messageId: MSG,
                toolName: 'bash.run',
                exitCode: 0,
            }),
            commandPart({
                id: 'c2',
                status: 'completed',
                messageId: MSG,
                toolName: 'bash.run',
                exitCode: 1,
            }),
            toolPart({ id: 't3', status: 'failed', messageId: MSG, toolName: 'write' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(formatExpandedBreakdown(agg)).toEqual([
            'file.edit  ×1 (+2 -1)',
            'repo.read  ×1',
            'bash.run  ×2 (exit 0/1)',
            '⚠ failed ×1',
        ]);
    });

    it('omits failed line when failedCount is zero', () => {
        const parts = [
            toolPart({ id: 't1', status: 'completed', messageId: MSG, toolName: 'read' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(formatExpandedBreakdown(agg)).toEqual(['read  ×1']);
    });

    it('returns only the failed line when there are no successes', () => {
        const parts = [
            toolPart({ id: 't1', status: 'failed', messageId: MSG, toolName: 'edit' }),
            toolPart({ id: 't2', status: 'interrupted', messageId: MSG, toolName: 'write' }),
        ];
        const agg = aggregateToolCallsForMessage(parts, MSG);
        expect(formatExpandedBreakdown(agg)).toEqual(['⚠ failed ×2']);
    });
});
