import { type AgentEvent, AgentEventSchema } from '@mission-control/protocol';
import { parseArgs } from '../args.js';
import { runSessionCommand } from './session.js';

export async function replayedMessages(sessionId: string): Promise<readonly string[]> {
    return replayedEvents(sessionId).then((events) =>
        events.map((event) => event.message).filter((message): message is string => message !== undefined),
    );
}

export async function replayedTypes(sessionId: string): Promise<readonly string[]> {
    return replayedEvents(sessionId).then((events) => events.map((event) => event.type));
}

export async function replayedEvents(sessionId: string): Promise<readonly AgentEvent[]> {
    const output = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
    return output
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => replayEventFromUnknown(JSON.parse(line)));
}

function replayEventFromUnknown(value: unknown): readonly AgentEvent[] {
    if (!isRecord(value) || value.kind !== 'event') {
        return [];
    }
    return [AgentEventSchema.parse(value.event)];
}

function isRecord(value: unknown): value is { readonly kind?: unknown; readonly event?: unknown } {
    return typeof value === 'object' && value !== null;
}
