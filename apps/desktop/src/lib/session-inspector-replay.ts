import {
    type ApprovalProjection,
    type CodingReplayStep,
    projectSessionReplay,
    type ReplayDiagnostic,
    type ToolOutcomeProjection,
} from '@mission-control/core/replay';
import type { AgentEvent } from '@mission-control/protocol';
import type { DesktopSessionDiagnostic, DesktopSessionLog } from './agent-client.js';
import { redactDisplayText } from './redaction.js';
import { approvalPreviewForRecord, type ToolCallPreview } from './tool-call-preview.js';

export type ApprovalRow = {
    readonly key: string;
    readonly approvalId: string;
    readonly state: string;
    readonly subject: string;
    readonly reason: string;
    readonly preview: ToolCallPreview | undefined;
};

export type CodingStepRow = {
    readonly key: string;
    readonly kind: CodingReplayStep['kind'];
    readonly timestamp: string;
    readonly subject: string;
    readonly status: string;
    readonly detail: string;
};

export type ToolOutcomeRow = {
    readonly key: string;
    readonly toolId: string;
    readonly status: string;
    readonly timestamps: string;
    readonly detail: string;
};

export type ReplayInspectorRows = {
    readonly approvals: readonly ApprovalRow[];
    readonly codingSteps: readonly CodingStepRow[];
    readonly toolOutcomes: readonly ToolOutcomeRow[];
    readonly diagnostics: readonly DesktopSessionDiagnostic[];
};

export function projectReplayInspectorRows(selectedLog: DesktopSessionLog | undefined): ReplayInspectorRows {
    if (selectedLog === undefined) {
        return emptyReplayRows();
    }
    const replay = projectSessionReplay({
        sessionId: selectedLog.sessionId,
        envelopes: selectedLog.envelopes,
    });
    const events = selectedLog.envelopes.map((envelope) => envelope.event);
    return {
        approvals: approvalRows(replay.approvals, events),
        codingSteps: replay.codingSteps.map(codingStepRow),
        toolOutcomes: replay.toolOutcomes.map(toolOutcomeRow),
        diagnostics: replay.diagnostics.map(replayDiagnosticRow),
    };
}

function emptyReplayRows(): ReplayInspectorRows {
    return {
        approvals: [],
        codingSteps: [],
        toolOutcomes: [],
        diagnostics: [],
    };
}

function approvalRows(approvals: readonly ApprovalProjection[], events: readonly AgentEvent[]): readonly ApprovalRow[] {
    return approvals.map((record, index) => ({
        key: `${record.approvalId}-${index}`,
        approvalId: record.approvalId,
        state: record.state,
        subject: `${record.subject.kind}:${record.subject.id}`,
        reason: redactDisplayText(record.reason ?? ''),
        preview: approvalPreviewForRecord(record, events),
    }));
}

function codingStepRow(step: CodingReplayStep): CodingStepRow {
    switch (step.kind) {
        case 'provider.tool_call':
            return {
                key: step.eventId,
                kind: step.kind,
                timestamp: step.timestamp,
                subject: `${step.toolName} ${step.toolCallId}`,
                status: 'requested',
                detail: step.taskId ?? '',
            };
        case 'provider.message':
            return {
                key: step.eventId,
                kind: step.kind,
                timestamp: step.timestamp,
                subject: step.messageId,
                status: step.continuation ? 'continuation' : 'initial',
                detail: redactDisplayText(step.message),
            };
        case 'approval':
            return {
                key: step.eventId,
                kind: step.kind,
                timestamp: step.timestamp,
                subject: `${step.subject.kind}:${step.subject.id}`,
                status: step.state,
                detail: step.approvalId,
            };
        case 'tool.result':
            return {
                key: step.eventId,
                kind: step.kind,
                timestamp: step.timestamp,
                subject: step.toolCallId,
                status: step.status,
                detail: joinParts([
                    step.message,
                    step.output,
                    step.error?.message,
                    appliedFilesText(step.appliedFiles),
                ]),
            };
    }
}

function toolOutcomeRow(outcome: ToolOutcomeProjection): ToolOutcomeRow {
    return {
        key: outcome.toolId,
        toolId: outcome.toolId,
        status: outcome.status,
        timestamps: joinParts([outcome.startedAt, outcome.completedAt, outcome.failedAt]),
        detail: joinParts([outcome.lastMessage, resultDetail(outcome), appliedFilesText(outcome.appliedFiles)]),
    };
}

function resultDetail(outcome: ToolOutcomeProjection): string | undefined {
    if (outcome.result?.status === 'completed') {
        return outcome.result.output;
    }
    return outcome.result?.error?.message;
}

function appliedFilesText(appliedFiles: readonly string[] | undefined): string | undefined {
    if (appliedFiles === undefined || appliedFiles.length === 0) {
        return undefined;
    }
    return `applied: ${appliedFiles.map(redactDisplayText).join(', ')}`;
}

function replayDiagnosticRow(diagnostic: ReplayDiagnostic): DesktopSessionDiagnostic {
    switch (diagnostic.code) {
        case 'corrupt_trailing_record':
            return {
                code: diagnostic.code,
                lineNumber: diagnostic.lineNumber,
                message: 'corrupt trailing JSONL record',
            };
        case 'missing_provider_continuation':
            return {
                code: diagnostic.code,
                message: `missing provider continuation for ${redactDisplayText(diagnostic.toolName)} (${redactDisplayText(
                    diagnostic.toolCallId,
                )})`,
            };
    }
}

function joinParts(parts: readonly (string | undefined)[]): string {
    return parts
        .filter((part): part is string => part !== undefined && part.length > 0)
        .map(redactDisplayText)
        .join(' | ');
}
