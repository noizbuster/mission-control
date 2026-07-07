import type {
    CommandExecutionRequest,
    CommandExecutionResult,
    ProviderAdapter,
    ProviderAdapterContext,
    ProviderTurnRequest,
} from '@mission-control/core';
import type { ProviderStreamChunk } from '@mission-control/protocol';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const mcpFixturePath = fileURLToPath(
    new URL('../../../../packages/core/src/tools/mcp/fixtures/stdio-fixture-server.mjs', import.meta.url),
);

export async function tempRoot(tempRoots: string[], prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}

export function firstAdvertisedToolNames(requests: readonly ProviderTurnRequest[]): readonly string[] {
    return requests.find((request) => request.tools !== undefined)?.tools?.map((tool) => tool.name) ?? [];
}

export async function writeToolWorkflow(workspaceRoot: string, name: string): Promise<void> {
    const workflowsDir = join(workspaceRoot, '.mctrl', 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(
        join(workflowsDir, `${name}.workflow.json`),
        JSON.stringify({
            name,
            graph: {
                id: name,
                version: '0.1.0',
                entryNodeId: 'llm-actor',
                defaults: {
                    maxNodeRuns: 4,
                },
                nodes: [
                    {
                        id: 'llm-actor',
                        kind: 'llm',
                        label: 'Registry test tool surface',
                    },
                ],
                edges: [],
                rules: [],
                policies: [],
            },
        }),
        'utf8',
    );
}

type ProviderStep =
    | {
          readonly kind: 'tool_call_completed';
          readonly toolCallId: string;
          readonly toolName: string;
          readonly argumentsJson: string;
      }
    | {
          readonly kind: 'response_completed';
          readonly content: string;
      };

export function providerFromTurns(
    requests: ProviderTurnRequest[],
    turns: readonly (readonly ProviderStep[])[],
): ProviderAdapter {
    return {
        async *streamTurn(request: ProviderTurnRequest, _context: ProviderAdapterContext) {
            requests.push(request);
            const steps = turns[requests.length - 1] ?? [{ kind: 'response_completed', content: 'done' }];
            for (const [index, step] of steps.entries()) {
                yield chunkForStep(request, step, index + 1);
            }
        },
    };
}

function chunkForStep(request: ProviderTurnRequest, step: ProviderStep, sequence: number): ProviderStreamChunk {
    if (step.kind === 'tool_call_completed') {
        return {
            kind: 'tool_call_completed',
            requestId: request.requestId,
            sequence,
            toolCall: {
                toolCallId: step.toolCallId,
                toolName: step.toolName,
                argumentsJson: step.argumentsJson,
            },
        };
    }
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence,
        message: {
            messageId: `message_${request.turnId}`,
            role: 'assistant',
            content: step.content,
        },
        finishReason: 'stop',
    };
}

export function addFilePatch(path: string, content: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+${content}`,
        '',
    ].join('\n');
}

export async function fakeCommandExecutor(_request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'task4 ok\n',
        stderr: '',
        durationMs: 1,
    };
}
