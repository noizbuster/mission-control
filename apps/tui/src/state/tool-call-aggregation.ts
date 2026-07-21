import type { TranscriptPart, TranscriptPartStatus } from './transcript-part';

export type ToolCallAggregate = {
    readonly totalCount: number;
    readonly failedCount: number;
    readonly byToolName: ReadonlyMap<string, number>;
    readonly mutationDeltas: ReadonlyMap<string, { readonly added: number; readonly removed: number }>;
    readonly commandExitCodes: ReadonlyMap<string, readonly number[]>;
};

const SUCCESS_STATUSES = new Set<TranscriptPartStatus>([
    'completed',
    'informational',
    'historical',
    'background',
]);

const FAILED_STATUSES = new Set<TranscriptPartStatus>([
    'failed',
    'denied',
    'interrupted',
    'cancelled',
]);

const MUTATION_TOOL_NAMES = new Set<string>([
    'file.edit',
    'file.write',
    'file.patch',
    'hashline_edit',
    'edit',
    'write',
    'patch',
]);

export function isSuccessfulToolStatus(status: TranscriptPartStatus | undefined): boolean {
    return status !== undefined && SUCCESS_STATUSES.has(status);
}

export function isFailedToolStatus(status: TranscriptPartStatus | undefined): boolean {
    return status !== undefined && FAILED_STATUSES.has(status);
}

export function isAggregatableToolPart(part: TranscriptPart): boolean {
    switch (part.type) {
        case 'inline-tool':
        case 'block-tool':
        case 'command':
        case 'subagent':
            return true;
        default:
            return false;
    }
}

export function resolveToolDisplayName(part: TranscriptPart): string {
    const toolName = 'toolName' in part ? part.toolName : undefined;
    if (toolName !== undefined && toolName.length > 0) {
        return toolName;
    }
    switch (part.type) {
        case 'command':
            return 'command';
        case 'subagent':
            return part.agentName ?? 'task';
        default:
            return '<unknown>';
    }
}

export function countDiffDelta(lines: readonly string[]): { readonly added: number; readonly removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of lines) {
        if (line.startsWith('+++') || line.startsWith('---')) {
            continue;
        }
        if (line.startsWith('+')) {
            added += 1;
        } else if (line.startsWith('-')) {
            removed += 1;
        }
    }
    return { added, removed };
}

type MutableDelta = { added: number; removed: number };

function sumLinkedDiffDeltas(
    parts: readonly TranscriptPart[],
    messageId: string,
    toolCallId: string,
): MutableDelta {
    let added = 0;
    let removed = 0;
    for (const part of parts) {
        if (part.type !== 'diff' || part.messageId !== messageId || part.toolCallId !== toolCallId) {
            continue;
        }
        const delta = countDiffDelta(part.text.split('\n'));
        added += delta.added;
        removed += delta.removed;
    }
    return { added, removed };
}

function addDelta(deltas: Map<string, MutableDelta>, name: string, delta: MutableDelta): void {
    if (delta.added === 0 && delta.removed === 0) {
        return;
    }
    const existing = deltas.get(name);
    if (existing === undefined) {
        deltas.set(name, { added: delta.added, removed: delta.removed });
        return;
    }
    existing.added += delta.added;
    existing.removed += delta.removed;
}

function addExitCode(exitCodes: Map<string, number[]>, name: string, exitCode: number): void {
    const existing = exitCodes.get(name);
    if (existing === undefined) {
        exitCodes.set(name, [exitCode]);
        return;
    }
    if (!existing.includes(exitCode)) {
        existing.push(exitCode);
        existing.sort((left, right) => left - right);
    }
}

export function aggregateToolCallsForMessage(
    parts: readonly TranscriptPart[],
    messageId: string,
): ToolCallAggregate {
    let totalCount = 0;
    let failedCount = 0;
    const byToolName = new Map<string, number>();
    const mutationDeltas = new Map<string, MutableDelta>();
    const commandExitCodes = new Map<string, number[]>();

    for (const part of parts) {
        if (!isAggregatableToolPart(part)) {
            continue;
        }
        if (!('messageId' in part) || part.messageId !== messageId) {
            continue;
        }

        const status = 'status' in part ? part.status : undefined;
        const success = isSuccessfulToolStatus(status);
        const failed = isFailedToolStatus(status);
        if (!success && !failed) {
            continue;
        }

        const displayName = resolveToolDisplayName(part);

        if (success) {
            totalCount += 1;
            byToolName.set(displayName, (byToolName.get(displayName) ?? 0) + 1);

            const rawToolName = 'toolName' in part ? part.toolName : undefined;
            if (rawToolName !== undefined && MUTATION_TOOL_NAMES.has(rawToolName)) {
                let delta = countDiffDelta(part.text.split('\n'));
                if (delta.added === 0 && delta.removed === 0 && 'toolCallId' in part && part.toolCallId !== undefined) {
                    delta = sumLinkedDiffDeltas(parts, messageId, part.toolCallId);
                }
                addDelta(mutationDeltas, displayName, delta);
            }
        } else {
            failedCount += 1;
        }

        if (part.type === 'command' && typeof part.exitCode === 'number') {
            addExitCode(commandExitCodes, displayName, part.exitCode);
        }
    }

    return {
        totalCount,
        failedCount,
        byToolName,
        mutationDeltas,
        commandExitCodes,
    };
}

export function formatInlineSummary(agg: ToolCallAggregate): string {
    if (agg.totalCount === 0) {
        return '';
    }
    const segments: string[] = [];
    for (const [name, count] of agg.byToolName) {
        segments.push(`${name} ×${count}`);
    }
    return segments.join(' · ');
}

export function formatChipLabel(agg: ToolCallAggregate, expanded: boolean): string {
    const marker = expanded ? '-' : '+';
    if (agg.totalCount === 0 && agg.failedCount === 0) {
        return '';
    }
    if (agg.failedCount === 0) {
        return `${agg.totalCount} tools · [${marker}]`;
    }
    if (agg.totalCount === 0) {
        return `${agg.failedCount} failed · [${marker}]`;
    }
    return `${agg.totalCount} tools · ${agg.failedCount} failed · [${marker}]`;
}

export function formatExpandedBreakdown(agg: ToolCallAggregate): readonly string[] {
    const lines: string[] = [];
    for (const [name, count] of agg.byToolName) {
        let line = `${name}  ×${count}`;
        const delta = agg.mutationDeltas.get(name);
        if (delta !== undefined && (delta.added !== 0 || delta.removed !== 0)) {
            line += ` (+${delta.added} -${delta.removed})`;
        }
        const codes = agg.commandExitCodes.get(name);
        if (codes !== undefined && codes.length > 0) {
            line += ` (exit ${codes.join('/')})`;
        }
        lines.push(line);
    }
    if (agg.failedCount > 0) {
        lines.push(`⚠ failed ×${agg.failedCount}`);
    }
    return lines;
}
