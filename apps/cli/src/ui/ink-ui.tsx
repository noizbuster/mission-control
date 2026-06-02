import type { AgentEvent, AgentSession } from '@mission-control/protocol';

export function renderInkSummary(session: AgentSession, events: readonly AgentEvent[]): string {
    const lastEvent = events.at(-1);
    const lastMessage = lastEvent?.message ?? 'waiting';
    return [
        'mission-control',
        'command: mctrl',
        `session: ${session.id}`,
        `current status: ${session.status}`,
        `event list: ${events.map((event) => event.type).join(', ')}`,
        'running task count: 0',
        `last message: ${lastMessage}`,
        'native sidecar status: mock',
        'Ctrl+C to exit',
    ].join('\n');
}
