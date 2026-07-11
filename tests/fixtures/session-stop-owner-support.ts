import type { SessionControlStopContext } from '../../packages/core/dist/index.js';
import { appendFencedSessionStopEvent } from '../../packages/core/dist/runtime/session-stop-event-writer.js';
import type { AgentEvent } from '../../packages/protocol/dist/index.js';

export const OWNER_FIXTURE_SESSION_IDS = ['mc-stop-root', 'mc-stop-child', 'mc-stop-grandchild'] as const;
export type OwnerFixtureSessionId = (typeof OWNER_FIXTURE_SESSION_IDS)[number];
export const OWNER_FIXTURE_SCENARIOS = ['active', 'blocked', 'tree', 'noncooperative', 'owner-death'] as const;
export type OwnerFixtureScenario = (typeof OWNER_FIXTURE_SCENARIOS)[number];

export const OWNER_FIXTURE_STATE_TABLE = {
    active: { root: 'running', child: 'idle(aborted)', grandchild: 'absent' },
    blocked: { root: 'running', child: 'idle(aborted)', grandchild: 'absent' },
    tree: { root: 'running', child: 'idle(aborted)', grandchild: 'idle(aborted)' },
    noncooperative: { root: 'running', child: 'idle(aborted)', grandchild: 'running(timeout)' },
    'owner-death': {
        root: 'running(stale-owner)',
        child: 'running(stale-owner)',
        grandchild: 'running(stale-owner)',
    },
} as const;

export type OwnerFixtureCommand =
    | { readonly command: 'release'; readonly handleId: string }
    | { readonly command: 'spawn-child'; readonly parentId: string; readonly childId: string }
    | { readonly command: 'shutdown' };

export type DeferredHandle = { readonly promise: Promise<void>; readonly resolve: () => void };

export function createOwnerFixtureReady(scenario: OwnerFixtureScenario, dbPath: string) {
    return { type: 'ready' as const, scenario, dbPath, sessionIds: OWNER_FIXTURE_SESSION_IDS };
}

export function createOwnerFixtureAck(command: OwnerFixtureCommand['command']) {
    return { type: 'ack' as const, command, ok: true as const };
}

export function parseOwnerFixtureCommand(line: string): OwnerFixtureCommand {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        throw new TypeError('invalid owner fixture command');
    }
    if (!isRecord(value) || typeof value.command !== 'string') throw new TypeError('invalid owner fixture command');
    if (value.command === 'shutdown') return { command: 'shutdown' };
    if (value.command === 'release' && typeof value.handleId === 'string' && value.handleId.length > 0) {
        return { command: 'release', handleId: value.handleId };
    }
    if (
        value.command === 'spawn-child' &&
        typeof value.parentId === 'string' &&
        value.parentId.length > 0 &&
        typeof value.childId === 'string' &&
        value.childId.length > 0
    ) {
        return { command: 'spawn-child', parentId: value.parentId, childId: value.childId };
    }
    throw new TypeError('invalid owner fixture command');
}

export function parseOwnerFixtureArgs(args: readonly string[]): {
    readonly dataDir: string;
    readonly scenario: OwnerFixtureScenario;
} {
    const dataIndex = args.indexOf('--data-dir');
    const scenarioIndex = args.indexOf('--scenario');
    const dataDir = dataIndex >= 0 ? args[dataIndex + 1] : undefined;
    const scenario = scenarioIndex >= 0 ? args[scenarioIndex + 1] : undefined;
    if (dataDir === undefined || !OWNER_FIXTURE_SCENARIOS.some((value) => value === scenario)) {
        throw new TypeError('usage: session-stop-owner --data-dir <path> --scenario <scenario>');
    }
    return { dataDir, scenario };
}

export function sessionStarted(sessionId: string): AgentEvent {
    return { type: 'session.started', timestamp: new Date().toISOString(), sessionId };
}

export function sessionRunStarted(sessionId: string): AgentEvent {
    return {
        type: 'run.started',
        timestamp: new Date().toISOString(),
        sessionId,
        run: { command: 'run', state: 'running', runId: `run-${sessionId}` },
    };
}

export function blockedSessionEvents(sessionId: string): readonly AgentEvent[] {
    const timestamp = new Date().toISOString();
    return [
        sessionStarted(sessionId),
        {
            type: 'prompt.admitted',
            timestamp,
            sessionId,
            message: 'blocked fixture prompt',
            transcript: {
                inputId: 'input-blocked',
                messageId: 'message-blocked',
                delivery: 'queue',
                visibility: 'pending',
            },
        },
        {
            type: 'approval.requested',
            timestamp,
            sessionId,
            approvalRecord: {
                approvalId: 'approval-blocked',
                requestId: 'approval-request',
                policyDecision: 'requires_approval',
                state: 'pending',
                subject: { kind: 'tool', id: 'tool-blocked' },
                requestedAt: timestamp,
            },
        },
        sessionRunStarted(sessionId),
        {
            type: 'run.blocked',
            timestamp,
            sessionId,
            run: {
                command: 'run',
                state: 'blocked_on_approval',
                runId: `run-${sessionId}`,
                toolCallId: 'tool-blocked',
            },
        },
    ];
}

export async function writeInterruptedRun(
    client: Parameters<typeof appendFencedSessionStopEvent>[0]['client'],
    sessionId: string,
    context: SessionControlStopContext,
): Promise<void> {
    if (context.kind !== 'operator_stop') return;
    await appendFencedSessionStopEvent({
        client,
        sessionId,
        event: {
            type: 'run.interrupted',
            timestamp: context.timestamp,
            sessionId,
            run: {
                state: 'interrupted',
                runId: `run-${sessionId}`,
                requestId: context.requestId,
                operationId: context.operationId,
                reason: 'operator_aborted',
            },
        },
    });
}

export function createDeferredHandle(): DeferredHandle {
    let resolve = (): void => {};
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
