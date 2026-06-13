import { projectSessionReplay, type SessionTreeProjection } from '@mission-control/core/replay';
import type { DesktopSessionLog, DesktopSessionSummary } from './agent-client.js';
import { redactDisplayText } from './redaction.js';

export type SessionListRow = {
    readonly sessionId: string;
    readonly fileName: string;
    readonly state: DesktopSessionSummary['state'];
    readonly eventCount: number;
    readonly lockState: DesktopSessionSummary['lockState'];
    readonly updatedAt?: string;
    readonly workspaceTrust?: 'trusted' | 'denied' | 'unknown';
    readonly blockedRunCount?: number;
    readonly pendingApprovalCount?: number;
};

export type SessionTreeRow = {
    readonly key: string;
    readonly entryId: string;
    readonly parentEntryId: string;
    readonly eventType: string;
    readonly timestamp: string;
    readonly message: string;
    readonly active: boolean;
};

export type SessionTreePanel = {
    readonly sessionName: string;
    readonly cwd: string;
    readonly trustedRoot: string;
    readonly workspaceTrust: string;
    readonly parentSessionId: string;
    readonly activeLeafId: string;
    readonly forkSourceSessionId: string;
    readonly cloneSourceSessionId: string;
    readonly entryCount: number;
    readonly branchCount: number;
    readonly compactionCount: number;
    readonly exportCount: number;
    readonly importCount: number;
    readonly rows: readonly SessionTreeRow[];
};

export type SessionStatsPanel = {
    readonly eventCount: number;
    readonly pendingApprovalCount: number;
    readonly blockedRunCount: number;
    readonly commandEventCount: number;
    readonly diffEventCount: number;
    readonly toolOutcomeCount: number;
};

export type SessionDetailProjection = {
    readonly sessionList: readonly SessionListRow[];
    readonly sessionTree: SessionTreePanel | undefined;
    readonly stats: SessionStatsPanel | undefined;
};

export function projectSessionDetail(input: {
    readonly sessions: readonly DesktopSessionSummary[];
    readonly selectedLog: DesktopSessionLog | undefined;
}): SessionDetailProjection {
    const selectedReplay =
        input.selectedLog === undefined
            ? undefined
            : projectSessionReplay({
                  sessionId: input.selectedLog.sessionId,
                  envelopes: input.selectedLog.envelopes,
              });
    return {
        sessionList: input.sessions.map((session) => ({
            sessionId: session.sessionId,
            fileName: session.fileName,
            state: session.state,
            eventCount: session.eventCount,
            lockState: session.lockState,
            ...(session.updatedAt !== undefined ? { updatedAt: session.updatedAt } : {}),
            ...(session.sessionTree?.workspaceTrust !== undefined
                ? { workspaceTrust: session.sessionTree.workspaceTrust }
                : {}),
            ...(session.stats?.blockedRunCount !== undefined ? { blockedRunCount: session.stats.blockedRunCount } : {}),
            ...(session.stats?.pendingApprovalCount !== undefined
                ? { pendingApprovalCount: session.stats.pendingApprovalCount }
                : {}),
        })),
        sessionTree: selectedReplay === undefined ? undefined : sessionTreePanel(selectedReplay.sessionTree),
        stats: selectedReplay === undefined ? undefined : sessionStatsPanel(selectedReplay),
    };
}

function sessionTreePanel(sessionTree: SessionTreeProjection): SessionTreePanel {
    return {
        sessionName: sessionTree.sessionName ?? '',
        cwd: sessionTree.cwd ?? '',
        trustedRoot: sessionTree.trustedRoot ?? '',
        workspaceTrust: sessionTree.workspaceTrust ?? '',
        parentSessionId: sessionTree.parentSessionId ?? '',
        activeLeafId: sessionTree.activeLeafId ?? '',
        forkSourceSessionId: sessionTree.forkSource?.sessionId ?? '',
        cloneSourceSessionId: sessionTree.cloneSource?.sessionId ?? '',
        entryCount: sessionTree.nodes.length,
        branchCount: branchCount(sessionTree),
        compactionCount: sessionTree.compactionBoundaries.length,
        exportCount: sessionTree.exports.length,
        importCount: sessionTree.imports.length,
        rows: sessionTree.nodes.map((node) => ({
            key: node.entryId,
            entryId: node.entryId,
            parentEntryId: node.parentEntryId ?? '',
            eventType: node.eventType,
            timestamp: node.timestamp,
            message: redactDisplayText(node.message ?? ''),
            active: node.entryId === sessionTree.activeLeafId,
        })),
    };
}

function branchCount(sessionTree: SessionTreeProjection): number {
    if (sessionTree.nodes.length === 0) {
        return 0;
    }
    const leafCount = sessionTree.nodes.filter((node) => node.childEntryIds.length === 0).length;
    return leafCount > 0 ? leafCount : 1;
}

function sessionStatsPanel(replay: ReturnType<typeof projectSessionReplay>): SessionStatsPanel {
    return {
        eventCount: replay.events.length,
        pendingApprovalCount: replay.approvals.filter((approval) => approval.state === 'pending').length,
        blockedRunCount: currentBlockedRunCount(replay.codingSteps),
        commandEventCount: replay.events.filter((event) => event.command !== undefined).length,
        diffEventCount: replay.events.filter((event) => (event.diffFiles?.length ?? 0) > 0).length,
        toolOutcomeCount: replay.toolOutcomes.length,
    };
}

function currentBlockedRunCount(steps: ReturnType<typeof projectSessionReplay>['codingSteps']): number {
    const blockedRunIds = new Set<string>();
    for (const step of steps) {
        if (step.kind !== 'run.state' || step.runId === undefined) {
            continue;
        }
        if (step.state === 'blocked_on_approval') {
            blockedRunIds.add(step.runId);
            continue;
        }
        blockedRunIds.delete(step.runId);
    }
    return blockedRunIds.size;
}
