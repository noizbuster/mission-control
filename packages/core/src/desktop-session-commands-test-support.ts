import { AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { readLocalSessionReplay } from './memory/local-session-store';
import type { DeterministicProviderStep } from './providers/deterministic-provider';

export function fixedNow(): string {
    return '2026-06-09T00:00:00.000Z';
}

export function filePatchCall(toolCallId: string, filePath: string, content: string): DeterministicProviderStep {
    return {
        kind: 'tool_call_completed',
        toolCallId,
        toolName: 'file.patch',
        argumentsJson: JSON.stringify({
            patch: [
                `diff --git a/${filePath} b/${filePath}`,
                '--- /dev/null',
                `+++ b/${filePath}`,
                '@@ -0,0 +1 @@',
                `+${content}`,
                '',
            ].join('\n'),
        }),
    };
}

export function commandRunCall(toolCallId: string): DeterministicProviderStep {
    return {
        kind: 'tool_call_completed',
        toolCallId,
        toolName: 'command.run',
        argumentsJson: JSON.stringify({
            command: 'node',
            args: ['--eval', "console.log('mission-control command.run harness ok')"],
        }),
    };
}

export async function readReplay(dataDir: string, sessionId: string) {
    const result = await readLocalSessionReplay({ dataDir, sessionId });
    if (result.kind === 'missing') {
        throw new Error(`Session replay not found: ${sessionId}`);
    }
    const replay = result.replay.projection;
    return {
        ...replay,
        envelopes: replay.envelopes.map((envelope) => AgentEventEnvelopeSchema.parse(envelope)),
    };
}
