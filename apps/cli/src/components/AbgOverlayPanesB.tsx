import type { AbgToolOutcomeSnapshot, ApprovalRecord } from '@mission-control/protocol';
import { Box, Text } from 'ink';
import type { AbgOverlayState, RecentEvent } from '../commands/abg-overlay-state.js';

export interface AbgOverlayPaneProps {
    readonly state: AbgOverlayState;
}

export interface CostPolicyPaneProps {
    readonly state: AbgOverlayState;
    readonly modelLabel?: string;
}

function truncate(text: string | undefined, max: number): string {
    if (text === undefined) return '';
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
}

function shortTime(iso: string | undefined): string {
    if (iso === undefined) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function relativeTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const now = Date.now();
    const diffMs = now - date.getTime();
    if (diffMs < 0) return 'just now';
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function statusGlyph(status: AbgToolOutcomeSnapshot['status']): { glyph: string; color: string } {
    switch (status) {
        case 'started':
            return { glyph: '▶', color: 'yellow' };
        case 'completed':
            return { glyph: '✓', color: 'green' };
        case 'failed':
            return { glyph: '✗', color: 'red' };
        default:
            return { glyph: '?', color: 'dim' };
    }
}

function approvalStateColor(state: ApprovalRecord['state']): string {
    switch (state) {
        case 'pending':
            return 'yellow';
        case 'approved':
            return 'green';
        case 'denied':
            return 'red';
        case 'expired':
        case 'cancelled':
            return 'gray';
        default:
            return 'dim';
    }
}

export function ToolsPane({ state }: AbgOverlayPaneProps): React.ReactElement {
    const outcomes = state.toolOutcomes;
    return (
        <Box flexDirection="column" marginTop={1}>
            {outcomes.length === 0 ? (
                <Text dimColor>No tool calls yet</Text>
            ) : (
                outcomes.map((outcome: AbgToolOutcomeSnapshot, index: number) => {
                    const { glyph, color } = statusGlyph(outcome.status);
                    const toolId = truncate(outcome.toolId, 20);
                    const started = shortTime(outcome.startedAt);
                    const completed = shortTime(outcome.completedAt ?? outcome.failedAt);
                    const message = truncate(outcome.lastMessage, 60);
                    return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: tool outcomes are append-only within a single overlay render
                        <Box key={`${outcome.toolId}-${index}`} flexDirection="row">
                            <Text dimColor>{toolId}</Text>
                            <Text> </Text>
                            <Text color={color} bold>
                                {glyph}
                            </Text>
                            <Text> </Text>
                            <Text dimColor>{started}</Text>
                            {completed !== '' ? (
                                <>
                                    <Text dimColor> → </Text>
                                    <Text dimColor>{completed}</Text>
                                </>
                            ) : null}
                            {message !== '' ? (
                                <>
                                    <Text> </Text>
                                    <Text dimColor>{message}</Text>
                                </>
                            ) : null}
                        </Box>
                    );
                })
            )}
            <Box marginTop={1}>
                <Text dimColor>
                    live tool-start events arrive via graph signals; onToolSettlement does not fire for graph tools
                </Text>
            </Box>
        </Box>
    );
}

function timelineTaskGraph(event: RecentEvent): string {
    return event.nodeId ?? '';
}

function timelineNodeSignal(event: RecentEvent): string {
    return event.signal ?? '';
}

function timelineModelMessage(event: RecentEvent): string {
    return truncate(event.emitPayloadText ?? event.message, 60);
}

export function TimelinePane({ state }: AbgOverlayPaneProps): React.ReactElement {
    const events = state.recentEvents;
    return (
        <Box flexDirection="column" marginTop={1}>
            {events.length === 0 ? (
                <Text dimColor>No timeline events</Text>
            ) : (
                events.map((event: RecentEvent, index: number) => {
                    const type = truncate(event.type, 24);
                    const timestamp = event.timestamp !== '' ? shortTime(event.timestamp) : '';
                    const taskGraph = truncate(timelineTaskGraph(event), 16);
                    const nodeSignal = truncate(timelineNodeSignal(event), 16);
                    const modelMessage = timelineModelMessage(event);
                    return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: timeline events are append-only and capped at 200
                        <Box key={`${event.timestamp}-${event.type}-${index}`} flexDirection="row">
                            <Text>{type}</Text>
                            <Text dimColor> | </Text>
                            <Text dimColor>{timestamp}</Text>
                            <Text dimColor> | </Text>
                            <Text>{taskGraph}</Text>
                            <Text dimColor> | </Text>
                            <Text>{nodeSignal}</Text>
                            <Text dimColor> | </Text>
                            <Text dimColor>{modelMessage}</Text>
                        </Box>
                    );
                })
            )}
        </Box>
    );
}

export function ApprovalsPane({ state }: AbgOverlayPaneProps): React.ReactElement {
    const approvals = state.pendingApprovals;
    return (
        <Box flexDirection="column" marginTop={1}>
            {approvals.length === 0 ? (
                <Text dimColor>No pending approvals</Text>
            ) : (
                approvals.map((approval: ApprovalRecord, index: number) => {
                    const approvalId = truncate(approval.approvalId, 16);
                    const stateColor = approvalStateColor(approval.state);
                    const subject = `${approval.subject.kind}:${approval.subject.id}`;
                    const reason = approval.reason !== undefined ? truncate(approval.reason, 60) : '';
                    const requested = relativeTime(approval.requestedAt);
                    return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: pending approvals are append-only within a single overlay render
                        <Box key={`${approval.approvalId}-${index}`} flexDirection="column">
                            <Box flexDirection="row">
                                <Text dimColor>{approvalId}</Text>
                                <Text> </Text>
                                <Text color={stateColor} bold>
                                    [{approval.state}]
                                </Text>
                                <Text> </Text>
                                <Text>{subject}</Text>
                            </Box>
                            {reason !== '' ? (
                                <Box flexDirection="row">
                                    <Text dimColor>reason: </Text>
                                    <Text dimColor>{reason}</Text>
                                </Box>
                            ) : null}
                            <Box flexDirection="row">
                                <Text dimColor>requested: {requested}</Text>
                            </Box>
                        </Box>
                    );
                })
            )}
        </Box>
    );
}

const POLICY_EVENT_TYPES: ReadonlySet<string> = new Set([
    'policy.blocked',
    'policy.evaluated',
    'policy.budget.accumulated',
    'policy.budget.warning',
    'policy.budget.exceeded',
]);

function isPolicyEvent(event: RecentEvent): boolean {
    if (POLICY_EVENT_TYPES.has(event.type)) return true;
    if (event.emitPayloadText !== undefined) {
        for (const policyType of POLICY_EVENT_TYPES) {
            if (event.emitPayloadText.includes(policyType)) return true;
        }
    }
    return false;
}

export function CostPolicyPane({ state, modelLabel }: CostPolicyPaneProps): React.ReactElement {
    const cost = state.costCents !== undefined ? `$${(state.costCents / 100).toFixed(2)}` : '$0.00';
    const inputTokens = state.inputTokens;
    const outputTokens = state.outputTokens;
    const modelCalls = state.modelCalls;
    const policyEvents = state.recentEvents.filter(isPolicyEvent);
    const hasWarning = policyEvents.some((event) => event.type === 'policy.budget.warning');
    const hasExceeded = policyEvents.some((event) => event.type === 'policy.budget.exceeded');
    const costColor = hasExceeded ? 'red' : hasWarning ? 'yellow' : undefined;

    return (
        <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="column">
                <Text bold>Cost Summary</Text>
                {modelLabel !== undefined ? <Text dimColor>model: {modelLabel}</Text> : null}
                <Box flexDirection="row">
                    <Text {...(costColor !== undefined ? { color: costColor } : {})}>{cost}</Text>
                    <Text> / </Text>
                    <Text>{inputTokens} in</Text>
                    <Text> / </Text>
                    <Text>{outputTokens} out</Text>
                </Box>
                <Text dimColor>model calls: {modelCalls}</Text>
                {hasExceeded ? (
                    <Text bold color="red">
                        BUDGET EXCEEDED
                    </Text>
                ) : hasWarning ? (
                    <Text bold color="yellow">
                        approaching budget threshold
                    </Text>
                ) : null}
            </Box>
            <Box marginTop={1} flexDirection="column">
                <Text bold>Policy Events</Text>
                {policyEvents.length === 0 ? (
                    <Text dimColor>No policy events</Text>
                ) : (
                    policyEvents.map((event: RecentEvent, index: number) => {
                        const type = truncate(event.type, 24);
                        const timestamp = event.timestamp !== '' ? shortTime(event.timestamp) : '';
                        const message = truncate(event.emitPayloadText ?? event.message, 60);
                        const eventColor =
                            event.type === 'policy.budget.exceeded'
                                ? 'red'
                                : event.type === 'policy.budget.warning'
                                  ? 'yellow'
                                  : event.type === 'policy.blocked'
                                    ? 'red'
                                    : undefined;
                        return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: policy events are append-only within a single overlay render
                            <Box key={`policy-${event.timestamp}-${event.type}-${index}`} flexDirection="row">
                                <Text {...(eventColor !== undefined ? { color: eventColor } : {})}>{type}</Text>
                                <Text dimColor> </Text>
                                <Text dimColor>{timestamp}</Text>
                                {message !== '' ? (
                                    <>
                                        <Text dimColor> </Text>
                                        <Text dimColor>{message}</Text>
                                    </>
                                ) : null}
                            </Box>
                        );
                    })
                )}
            </Box>
        </Box>
    );
}

function formatBlackboardValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return '[unserializable]';
    }
}

function blackboardKeyColor(key: string): string | undefined {
    if (key.startsWith('goal') || key.startsWith('goal_')) return 'cyan';
    if (key.startsWith('hypothesis') || key.startsWith('hypothesis_')) return 'magenta';
    if (key.startsWith('observation') || key.startsWith('observation_')) return 'blue';
    if (key.startsWith('decision') || key.startsWith('decision_')) return 'green';
    if (key.startsWith('critic')) return 'yellow';
    if (key.startsWith('supervisor')) return 'red';
    return undefined;
}

export function BlackboardPane({ state }: AbgOverlayPaneProps): React.ReactElement {
    const entries = [...state.blackboardEntries.entries()].sort(([left], [right]) => left.localeCompare(right));
    const recentMutations = state.recentEvents.filter(
        (event) => event.type === 'blackboard.set' || event.type === 'blackboard.delete',
    );

    return (
        <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="column">
                <Text bold>Blackboard</Text>
                <Text dimColor>working memory: {entries.length} entries</Text>
                {entries.length === 0 ? (
                    <Text dimColor>
                        No blackboard entries — node runners (MemoryNode, LLMActor, Supervisor) will populate goals,
                        hypotheses, and observations here.
                    </Text>
                ) : (
                    entries.map(([key, value]) => {
                        const valueText = truncate(formatBlackboardValue(value), 80);
                        const keyColor = blackboardKeyColor(key);
                        return (
                            <Box key={`bb-${key}`} flexDirection="row">
                                <Text {...(keyColor !== undefined ? { color: keyColor } : {})} bold>
                                    {key}
                                </Text>
                                <Text dimColor> = </Text>
                                <Text dimColor>{valueText}</Text>
                            </Box>
                        );
                    })
                )}
            </Box>
            {recentMutations.length > 0 ? (
                <Box marginTop={1} flexDirection="column">
                    <Text bold>Recent Mutations</Text>
                    {recentMutations
                        .slice(-10)
                        .reverse()
                        .map((event, index) => {
                            const type = event.type === 'blackboard.set' ? 'set' : 'del';
                            const timestamp = event.timestamp !== '' ? shortTime(event.timestamp) : '';
                            const message = truncate(event.emitPayloadText ?? event.message, 60);
                            const color = event.type === 'blackboard.set' ? 'green' : 'red';
                            return (
                                // biome-ignore lint/suspicious/noArrayIndexKey: blackboard mutations are append-only within a render
                                <Box key={`bb-mut-${event.timestamp}-${index}`} flexDirection="row">
                                    <Text color={color}>{type}</Text>
                                    <Text dimColor> {timestamp}</Text>
                                    {message !== '' ? <Text dimColor> {message}</Text> : null}
                                </Box>
                            );
                        })}
                </Box>
            ) : null}
        </Box>
    );
}
