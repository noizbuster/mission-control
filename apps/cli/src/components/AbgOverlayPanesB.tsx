/** @jsxImportSource @opentui/react */
import type { AbgToolOutcomeSnapshot, ApprovalRecord } from '@mission-control/protocol';
import type React from 'react';
import type { AbgOverlayState, RecentEvent } from '../commands/abg-overlay-state.js';
import { toOpenTuiAttributes, toOpenTuiColor } from '../platform/opentui-types.js';

export interface AbgOverlayPaneProps {
    readonly state: AbgOverlayState;
}

export interface CostPolicyPaneProps {
    readonly state: AbgOverlayState;
    readonly modelLabel?: string;
}

const dimAttrs = toOpenTuiAttributes({ dimColor: true });
const boldAttrs = toOpenTuiAttributes({ bold: true });

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

function statusGlyph(status: AbgToolOutcomeSnapshot['status']): { glyph: string; fg: string | undefined } {
    switch (status) {
        case 'started':
            return { glyph: '▶', fg: toOpenTuiColor('yellow') };
        case 'completed':
            return { glyph: '✓', fg: toOpenTuiColor('green') };
        case 'failed':
            return { glyph: '✗', fg: toOpenTuiColor('red') };
        default:
            return { glyph: '?', fg: toOpenTuiColor('dim') };
    }
}

function approvalStateFg(state: ApprovalRecord['state']): string | undefined {
    switch (state) {
        case 'pending':
            return toOpenTuiColor('yellow');
        case 'approved':
            return toOpenTuiColor('green');
        case 'denied':
            return toOpenTuiColor('red');
        case 'expired':
        case 'cancelled':
            return toOpenTuiColor('gray');
        default:
            return toOpenTuiColor('dim');
    }
}

export function ToolsPane({ state }: AbgOverlayPaneProps): React.ReactNode {
    const outcomes = state.toolOutcomes;
    return (
        <box flexDirection="column" marginTop={1}>
            {outcomes.length === 0 ? (
                <text {...dimAttrs}>No tool calls yet</text>
            ) : (
                outcomes.map((outcome: AbgToolOutcomeSnapshot, index: number) => {
                    const { glyph, fg } = statusGlyph(outcome.status);
                    const toolId = truncate(outcome.toolId, 20);
                    const started = shortTime(outcome.startedAt);
                    const completed = shortTime(outcome.completedAt ?? outcome.failedAt);
                    const message = truncate(outcome.lastMessage, 60);
                    return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: tool outcomes are append-only within a single overlay render
                        <box key={`${outcome.toolId}-${index}`} flexDirection="row">
                            <text {...dimAttrs}>{toolId}</text>
                            <text> </text>
                            <text {...(fg !== undefined ? { fg } : {})} {...boldAttrs}>
                                {glyph}
                            </text>
                            <text> </text>
                            <text {...dimAttrs}>{started}</text>
                            {completed !== '' ? (
                                <>
                                    <text {...dimAttrs}> → </text>
                                    <text {...dimAttrs}>{completed}</text>
                                </>
                            ) : null}
                            {message !== '' ? (
                                <>
                                    <text> </text>
                                    <text {...dimAttrs}>{message}</text>
                                </>
                            ) : null}
                        </box>
                    );
                })
            )}
            <box marginTop={1}>
                <text {...dimAttrs}>
                    live tool-start events arrive via graph signals; onToolSettlement does not fire for graph tools
                </text>
            </box>
        </box>
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

export function TimelinePane({ state }: AbgOverlayPaneProps): React.ReactNode {
    const events = state.recentEvents;
    return (
        <box flexDirection="column" marginTop={1}>
            {events.length === 0 ? (
                <text {...dimAttrs}>No timeline events</text>
            ) : (
                events.map((event: RecentEvent, index: number) => {
                    const type = truncate(event.type, 24);
                    const timestamp = event.timestamp !== '' ? shortTime(event.timestamp) : '';
                    const taskGraph = truncate(timelineTaskGraph(event), 16);
                    const nodeSignal = truncate(timelineNodeSignal(event), 16);
                    const modelMessage = timelineModelMessage(event);
                    return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: timeline events are append-only and capped at 200
                        <box key={`${event.timestamp}-${event.type}-${index}`} flexDirection="row">
                            <text>{type}</text>
                            <text {...dimAttrs}> | </text>
                            <text {...dimAttrs}>{timestamp}</text>
                            <text {...dimAttrs}> | </text>
                            <text>{taskGraph}</text>
                            <text {...dimAttrs}> | </text>
                            <text>{nodeSignal}</text>
                            <text {...dimAttrs}> | </text>
                            <text {...dimAttrs}>{modelMessage}</text>
                        </box>
                    );
                })
            )}
        </box>
    );
}

export function ApprovalsPane({ state }: AbgOverlayPaneProps): React.ReactNode {
    const approvals = state.pendingApprovals;
    return (
        <box flexDirection="column" marginTop={1}>
            {approvals.length === 0 ? (
                <text {...dimAttrs}>No pending approvals</text>
            ) : (
                approvals.map((approval: ApprovalRecord, index: number) => {
                    const approvalId = truncate(approval.approvalId, 16);
                    const stateFg = approvalStateFg(approval.state);
                    const subject = `${approval.subject.kind}:${approval.subject.id}`;
                    const reason = approval.reason !== undefined ? truncate(approval.reason, 60) : '';
                    const requested = relativeTime(approval.requestedAt);
                    return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: pending approvals are append-only within a single overlay render
                        <box key={`${approval.approvalId}-${index}`} flexDirection="column">
                            <box flexDirection="row">
                                <text {...dimAttrs}>{approvalId}</text>
                                <text> </text>
                                <text {...(stateFg !== undefined ? { fg: stateFg } : {})} {...boldAttrs}>
                                    [{approval.state}]
                                </text>
                                <text> </text>
                                <text>{subject}</text>
                            </box>
                            {reason !== '' ? (
                                <box flexDirection="row">
                                    <text {...dimAttrs}>reason: </text>
                                    <text {...dimAttrs}>{reason}</text>
                                </box>
                            ) : null}
                            <box flexDirection="row">
                                <text {...dimAttrs}>requested: {requested}</text>
                            </box>
                        </box>
                    );
                })
            )}
        </box>
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

function policyEventFg(eventType: string): string | undefined {
    if (eventType === 'policy.budget.exceeded' || eventType === 'policy.blocked') return toOpenTuiColor('red');
    if (eventType === 'policy.budget.warning') return toOpenTuiColor('yellow');
    return undefined;
}

export function CostPolicyPane({ state, modelLabel }: CostPolicyPaneProps): React.ReactNode {
    const cost = state.costCents !== undefined ? `$${(state.costCents / 100).toFixed(2)}` : '$0.00';
    const inputTokens = state.inputTokens;
    const outputTokens = state.outputTokens;
    const modelCalls = state.modelCalls;
    const policyEvents = state.recentEvents.filter(isPolicyEvent);
    const hasWarning = policyEvents.some((event) => event.type === 'policy.budget.warning');
    const hasExceeded = policyEvents.some((event) => event.type === 'policy.budget.exceeded');
    const costFg = hasExceeded ? toOpenTuiColor('red') : hasWarning ? toOpenTuiColor('yellow') : undefined;
    const redFg = toOpenTuiColor('red');
    const yellowFg = toOpenTuiColor('yellow');

    return (
        <box flexDirection="column" marginTop={1}>
            <box flexDirection="column">
                <text {...boldAttrs}>Cost Summary</text>
                {modelLabel !== undefined ? <text {...dimAttrs}>model: {modelLabel}</text> : null}
                <box flexDirection="row">
                    <text {...(costFg !== undefined ? { fg: costFg } : {})}>{cost}</text>
                    <text> / </text>
                    <text>{inputTokens} in</text>
                    <text> / </text>
                    <text>{outputTokens} out</text>
                </box>
                <text {...dimAttrs}>model calls: {modelCalls}</text>
                {hasExceeded ? (
                    <text {...(redFg !== undefined ? { fg: redFg } : {})} {...boldAttrs}>
                        BUDGET EXCEEDED
                    </text>
                ) : hasWarning ? (
                    <text {...(yellowFg !== undefined ? { fg: yellowFg } : {})} {...boldAttrs}>
                        approaching budget threshold
                    </text>
                ) : null}
            </box>
            <box marginTop={1} flexDirection="column">
                <text {...boldAttrs}>Policy Events</text>
                {policyEvents.length === 0 ? (
                    <text {...dimAttrs}>No policy events</text>
                ) : (
                    policyEvents.map((event: RecentEvent, index: number) => {
                        const type = truncate(event.type, 24);
                        const timestamp = event.timestamp !== '' ? shortTime(event.timestamp) : '';
                        const message = truncate(event.emitPayloadText ?? event.message, 60);
                        const eventFg = policyEventFg(event.type);
                        return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: policy events are append-only within a single overlay render
                            <box key={`policy-${event.timestamp}-${event.type}-${index}`} flexDirection="row">
                                <text {...(eventFg !== undefined ? { fg: eventFg } : {})}>{type}</text>
                                <text {...dimAttrs}> </text>
                                <text {...dimAttrs}>{timestamp}</text>
                                {message !== '' ? (
                                    <>
                                        <text {...dimAttrs}> </text>
                                        <text {...dimAttrs}>{message}</text>
                                    </>
                                ) : null}
                            </box>
                        );
                    })
                )}
            </box>
        </box>
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

function blackboardKeyFg(key: string): string | undefined {
    if (key.startsWith('goal') || key.startsWith('goal_')) return toOpenTuiColor('cyan');
    if (key.startsWith('hypothesis') || key.startsWith('hypothesis_')) return toOpenTuiColor('magenta');
    if (key.startsWith('observation') || key.startsWith('observation_')) return toOpenTuiColor('blue');
    if (key.startsWith('decision') || key.startsWith('decision_')) return toOpenTuiColor('green');
    if (key.startsWith('critic')) return toOpenTuiColor('yellow');
    if (key.startsWith('supervisor')) return toOpenTuiColor('red');
    return undefined;
}

export function BlackboardPane({ state }: AbgOverlayPaneProps): React.ReactNode {
    const entries = [...state.blackboardEntries.entries()].sort(([left], [right]) => left.localeCompare(right));
    const recentMutations = state.recentEvents.filter(
        (event) => event.type === 'blackboard.set' || event.type === 'blackboard.delete',
    );
    const greenFg = toOpenTuiColor('green');
    const redFg = toOpenTuiColor('red');

    return (
        <box flexDirection="column" marginTop={1}>
            <box flexDirection="column">
                <text {...boldAttrs}>Blackboard</text>
                <text {...dimAttrs}>working memory: {entries.length} entries</text>
                {entries.length === 0 ? (
                    <text {...dimAttrs}>
                        No blackboard entries — node runners (MemoryNode, LLMActor, Supervisor) will populate goals,
                        hypotheses, and observations here.
                    </text>
                ) : (
                    entries.map(([key, value]) => {
                        const valueText = truncate(formatBlackboardValue(value), 80);
                        const keyFg = blackboardKeyFg(key);
                        return (
                            <box key={`bb-${key}`} flexDirection="row">
                                <text {...(keyFg !== undefined ? { fg: keyFg } : {})} {...boldAttrs}>
                                    {key}
                                </text>
                                <text {...dimAttrs}> = </text>
                                <text {...dimAttrs}>{valueText}</text>
                            </box>
                        );
                    })
                )}
            </box>
            {recentMutations.length > 0 ? (
                <box marginTop={1} flexDirection="column">
                    <text {...boldAttrs}>Recent Mutations</text>
                    {recentMutations
                        .slice(-10)
                        .reverse()
                        .map((event, index) => {
                            const type = event.type === 'blackboard.set' ? 'set' : 'del';
                            const timestamp = event.timestamp !== '' ? shortTime(event.timestamp) : '';
                            const message = truncate(event.emitPayloadText ?? event.message, 60);
                            const mutFg = event.type === 'blackboard.set' ? greenFg : redFg;
                            return (
                                // biome-ignore lint/suspicious/noArrayIndexKey: blackboard mutations are append-only within a render
                                <box key={`bb-mut-${event.timestamp}-${index}`} flexDirection="row">
                                    <text {...(mutFg !== undefined ? { fg: mutFg } : {})}>{type}</text>
                                    <text {...dimAttrs}> {timestamp}</text>
                                    {message !== '' ? <text {...dimAttrs}> {message}</text> : null}
                                </box>
                            );
                        })}
                </box>
            ) : null}
        </box>
    );
}
