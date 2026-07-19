import type { PermissionRequest, ToolCall } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES } from './interactive-coding-file-write-preview';
import { preflightInteractiveToolCall } from './interactive-coding-tools';
import { fakeBroker, toolCall, toolOptions } from './interactive-coding-tools-test-support';
import { createBufferedChatOutput } from './run-agent-chat-test-support';

const hostileDisplayPayload =
    'credential sk-displayblocker123 OSC:\u001b]52;c;UE9D\u0007 C0:\u0001 C1:\u009b CR:\r TAB:\t BIDI:\u202e';
const sanitizedDisplayPayload =
    'credential [REDACTED_CREDENTIAL] OSC:\\u{001B}]52;c;UE9D\\u{0007} C0:\\u{0001} C1:\\u{009B} CR:\\u{000D} TAB:\\u{0009} BIDI:\\u{202E}';

describe('interactive coding tool preflight display sanitization', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sanitizes the dormant task notice while preserving raw permission authority', async () => {
        // Given
        const output = createBufferedChatOutput();
        const notices: string[] = [];
        const requests: PermissionRequest[] = [];
        const call = toolCall('task', 'task_raw_identity', { description: hostileDisplayPayload });

        // When
        const settlement = await preflightInteractiveToolCall(
            call,
            toolOptions({ ...output.output, showNotice: (message) => notices.push(message) }),
            {
                requestApproval: async () => {
                    throw new Error('requestApproval should not be called');
                },
                requestPermission: async (request) => {
                    requests.push(request);
                    return { requestId: request.id, status: 'allow', reason: 'test approval' };
                },
                primeApproval: () => undefined,
                answer: () => false,
                cancel: () => undefined,
                hasPending: () => false,
                setApprovalLevel: () => undefined,
            },
        );

        // Then
        expect(settlement).toBeUndefined();
        expect(notices).toEqual([`Task: ${sanitizedDisplayPayload}`]);
        expect(requests).toEqual([
            expect.objectContaining({
                id: 'permission_task_raw_identity',
                reason: `delegate sub-task: ${hostileDisplayPayload}`,
                permission: expect.objectContaining({ patterns: [hostileDisplayPayload] }),
            }),
        ]);
        expect(call).toEqual(toolCall('task', 'task_raw_identity', { description: hostileDisplayPayload }));
    });

    it('fails oversized file.write arguments before parsing or requesting permission', async () => {
        // Given
        const output = createBufferedChatOutput();
        const call = toolCall('file.write', 'write_oversized', {
            path: 'oversized.txt',
            content: '🙂'.repeat(Math.ceil(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES / 4)),
        });
        const originalCall = { ...call };
        expect(Buffer.byteLength(call.argumentsJson, 'utf8')).toBeGreaterThan(FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES);
        const parse = vi.spyOn(JSON, 'parse');
        const approvals = fakeBroker();
        const requestPermission = vi.spyOn(approvals, 'requestPermission');
        const expectedResult = {
            toolCallId: 'write_oversized',
            status: 'failed',
            error: {
                code: 'tool_failed',
                message: `file_write_arguments_too_large: maximum ${FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES} bytes`,
                retryable: false,
            },
        };

        // When
        const settlement = await preflightInteractiveToolCall(
            call,
            toolOptions(output.output, process.cwd()),
            approvals,
        );

        // Then
        expect(settlement).toEqual({
            toolCallId: 'write_oversized',
            toolName: 'file.write',
            result: expectedResult,
            events: [
                {
                    type: 'tool.failed',
                    timestamp: expect.any(String),
                    taskId: 'write_oversized',
                    message: 'tool failed: file.write',
                    nativeSidecarStatus: 'mock',
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                    toolResult: expectedResult,
                },
            ],
        });
        expect(parse).not.toHaveBeenCalled();
        expect(requestPermission).not.toHaveBeenCalled();
        expect(output.getOutput()).toBe('');
        expect(call).toEqual(originalCall);
    });

    it('keeps normal file.write arguments parseable and permission-gated', async () => {
        // Given
        const output = createBufferedChatOutput();
        const call = toolCall('file.write', 'write_normal', {
            path: 'normal.txt',
            content: 'normal content\n',
        });
        const parse = vi.spyOn(JSON, 'parse');
        const approvals = fakeBroker();
        const requestPermission = vi.spyOn(approvals, 'requestPermission');
        const primeApproval = vi.spyOn(approvals, 'primeApproval');

        // When
        const settlement = await preflightInteractiveToolCall(
            call,
            toolOptions(output.output, process.cwd()),
            approvals,
        );

        // Then
        expect(settlement).toBeUndefined();
        expect(parse).toHaveBeenCalled();
        expect(requestPermission).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'file.write',
                permission: expect.objectContaining({ kind: 'write', patterns: ['normal.txt'] }),
            }),
        );
        expect(primeApproval).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'permission_write_normal',
                action: 'file.write',
                reason: 'write full contents to normal.txt',
                permission: expect.objectContaining({
                    kind: 'write',
                    patterns: ['normal.txt'],
                    workspaceRoot: process.cwd(),
                }),
            }),
            'test broker',
        );
    });

    it('keeps malformed under-budget file.write arguments on the parse-rejection path', async () => {
        // Given
        const output = createBufferedChatOutput();
        const call: ToolCall = {
            toolCallId: 'write_malformed',
            toolName: 'file.write',
            argumentsJson: '{"path":',
        };
        const originalCall = { ...call };
        const parse = vi.spyOn(JSON, 'parse');
        const approvals = fakeBroker();
        const requestPermission = vi.spyOn(approvals, 'requestPermission');

        // When
        const settlement = await preflightInteractiveToolCall(
            call,
            toolOptions(output.output, process.cwd()),
            approvals,
        );

        // Then
        expect(settlement).toBeUndefined();
        expect(parse).toHaveBeenCalledTimes(1);
        expect(requestPermission).not.toHaveBeenCalled();
        expect(output.getOutput()).toBe('');
        expect(call).toEqual(originalCall);
    });
});
