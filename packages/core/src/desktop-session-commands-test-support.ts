import { AgentEventEnvelopeSchema } from '@mission-control/protocol';
import type { DeterministicProviderStep } from './providers/deterministic-provider.js';
import { projectJsonlSessionReplayPrefix } from './session-replay.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
            command: 'pnpm',
            args: ['exec', 'vitest', 'run', 'packages/core/src/tools/command-run.fixture.test.ts'],
        }),
    };
}

export async function readReplay(dataDir: string, sessionId: string) {
    const contents = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');
    const replay = projectJsonlSessionReplayPrefix({ sessionId, contents }).projection;
    return {
        ...replay,
        envelopes: replay.envelopes.map((envelope) => AgentEventEnvelopeSchema.parse(envelope)),
    };
}
