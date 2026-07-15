import { AgentRuntime } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { JsonRenderer, PlainRenderer } from './renderers';

const NOW = '2026-07-13T00:00:00.000Z';
const REDACTED_CREDENTIAL = '[REDACTED_CREDENTIAL]';

function secretBearingEvents(): readonly AgentEvent[] {
    const reasoningSecret = ['sk', 'renderer', 'reasoning123'].join('-');
    const responseSecret = ['sk', 'renderer', 'response123'].join('-');
    const proposalSecret = ['sk', 'renderer', 'proposal123'].join('-');
    const outputSecret = ['sk', 'renderer', 'output123'].join('-');
    const approvalSecret = ['sk', 'renderer', 'approval123'].join('-');
    return [
        {
            type: 'task.progress',
            timestamp: NOW,
            providerStreamChunk: {
                kind: 'reasoning_completed',
                requestId: 'request_renderer',
                sequence: 0,
                text: `reasoning ${reasoningSecret}`,
            },
        },
        {
            type: 'task.progress',
            timestamp: NOW,
            providerStreamChunk: {
                kind: 'response_completed',
                requestId: 'request_renderer',
                sequence: 1,
                message: {
                    messageId: 'message_renderer',
                    role: 'assistant',
                    content: `keep-this-response ${responseSecret}`,
                },
                finishReason: 'stop',
            },
        },
        {
            type: 'task.progress',
            timestamp: NOW,
            providerStreamChunk: {
                kind: 'tool_call_completed',
                requestId: 'request_renderer',
                sequence: 2,
                toolCall: {
                    toolCallId: 'call_renderer',
                    toolName: 'command.run',
                    argumentsJson: JSON.stringify({ command: 'keep-this-command', token: proposalSecret }),
                },
            },
        },
        {
            type: 'tool.completed',
            timestamp: NOW,
            taskId: 'call_renderer',
            toolResult: {
                toolCallId: 'call_renderer',
                status: 'completed',
                output: `keep-this-output ${outputSecret}`,
            },
        },
        {
            type: 'permission.requested',
            timestamp: NOW,
            message: 'permission requested: command.run',
            permissionRequest: {
                id: 'permission_renderer',
                action: 'command.run',
                reason: `run ${approvalSecret}`,
                permission: { kind: 'bash', patterns: [`node --token ${approvalSecret}`] },
            },
            permissionDecision: {
                requestId: 'permission_renderer',
                status: 'requires_approval',
                reason: `matched ${approvalSecret}`,
            },
        },
    ];
}

describe('CLI observability redaction', () => {
    it('redacts credential literals before JSON and plain rendering', async () => {
        // Given
        const events = secretBearingEvents();
        const raw = JSON.stringify(events);
        const secrets = [
            ['sk', 'renderer', 'reasoning123'].join('-'),
            ['sk', 'renderer', 'response123'].join('-'),
            ['sk', 'renderer', 'proposal123'].join('-'),
            ['sk', 'renderer', 'output123'].join('-'),
            ['sk', 'renderer', 'approval123'].join('-'),
        ];
        const runtime = new AgentRuntime({ useNative: false });
        const json = new JsonRenderer();
        const plain = new PlainRenderer({ thinking: true });
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        try {
            // When
            await json.start(runtime);
            await plain.start(runtime);
            for (const event of events) {
                json.render(event);
                plain.render(event);
            }
            const surfaces = [json.getOutput(), plain.getOutput()];

            // Then
            expect(secrets.every((secret) => raw.includes(secret))).toBe(true);
            expect(surfaces.map((surface) => surface.includes(REDACTED_CREDENTIAL))).toEqual([true, true]);
            expect(surfaces[0]?.includes('keep-this-command')).toBe(true);
            for (const surface of surfaces) {
                expect(surface.includes('keep-this-response')).toBe(true);
                for (const secret of secrets) {
                    expect(surface.includes(secret)).toBe(false);
                }
            }
        } finally {
            stdout.mockRestore();
        }
    });
});
