import type { AgentEvent, AgentSession } from '@mission-control/protocol';

export function renderPlainReport(session: AgentSession, events: readonly AgentEvent[]): string {
    const lines = [
        'mission-control',
        'command: mctrl',
        `session: ${session.id}`,
        ...events.map((event) => {
            const message = event.message ? ` ${event.message}` : '';
            return `${event.type}${message}`;
        }),
    ];

    return `${lines.join('\n')}\n`;
}
