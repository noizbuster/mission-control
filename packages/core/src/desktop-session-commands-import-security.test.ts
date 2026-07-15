import { defaultModelProviderSelection } from '@mission-control/config';
import { describe, expect, it } from 'vitest';
import { createDesktopSessionCommandService } from './desktop-session-commands';
import { fixedNow, readReplay } from './desktop-session-commands-test-support';
import { JsonlSessionEventStore } from './memory/jsonl-session-event-store';
import type { ProviderAdapter, ProviderTurnRequest } from './providers/provider-turn-types';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('desktop session imported approval security', () => {
    it('does not execute an approval restored from a legacy archive without local proposal authority', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-no-continuation-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-no-continuation-workspace-'));
        const providerRequests: ProviderTurnRequest[] = [];
        const sessionId = 'session_desktop_no_continuation';
        const store = await JsonlSessionEventStore.open({ dataDir, sessionId, now: fixedNow });

        try {
            await store.append({
                type: 'session.started',
                timestamp: fixedNow(),
                sessionId,
                message: 'desktop session started',
                nativeSidecarStatus: 'mock',
                modelProviderSelection: defaultModelProviderSelection,
            });
            await store.append({
                type: 'model.call.completed',
                timestamp: fixedNow(),
                sessionId,
                message: 'tool call completed: file.patch',
                nativeSidecarStatus: 'mock',
                modelProviderSelection: defaultModelProviderSelection,
                providerStreamChunk: {
                    kind: 'tool_call_completed',
                    requestId: 'request_no_continuation',
                    sequence: 1,
                    toolCall: {
                        toolCallId: 'call_patch_no_continuation',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({
                            patch: [
                                'diff --git a/.no-continuation.txt b/.no-continuation.txt',
                                '--- /dev/null',
                                '+++ b/.no-continuation.txt',
                                '@@ -0,0 +1 @@',
                                '+completed without resume',
                                '',
                            ].join('\n'),
                        }),
                    },
                },
            });
            await store.append({
                type: 'permission.requested',
                timestamp: fixedNow(),
                sessionId,
                message: 'permission requested: file.patch',
                nativeSidecarStatus: 'mock',
                modelProviderSelection: defaultModelProviderSelection,
                permissionRequest: {
                    id: 'permission_call_patch_no_continuation',
                    action: 'file.patch',
                    reason: 'approve file.patch',
                },
                permissionDecision: {
                    requestId: 'permission_call_patch_no_continuation',
                    status: 'requires_approval',
                    reason: 'approval required',
                },
            });
            await store.append({
                type: 'approval.requested',
                timestamp: fixedNow(),
                sessionId,
                message: 'approval requested: file.patch',
                nativeSidecarStatus: 'mock',
                modelProviderSelection: defaultModelProviderSelection,
                approvalRecord: {
                    approvalId: 'approval_permission_call_patch_no_continuation',
                    requestId: 'permission_call_patch_no_continuation',
                    policyDecision: 'requires_approval',
                    state: 'pending',
                    subject: { kind: 'tool', id: 'file.patch' },
                    requestedAt: fixedNow(),
                    reason: 'approve file.patch',
                },
            });
            await store.append({
                type: 'run.blocked',
                timestamp: fixedNow(),
                sessionId,
                message: 'waiting for approval: file.patch',
                nativeSidecarStatus: 'mock',
                modelProviderSelection: defaultModelProviderSelection,
                run: {
                    command: 'run',
                    state: 'blocked_on_approval',
                    runId: 'run_no_continuation',
                    reason: 'waiting for approval: file.patch',
                    toolCallId: 'call_patch_no_continuation',
                },
            });
        } finally {
            await store.close();
        }

        try {
            const service = createDesktopSessionCommandService({
                dataDir,
                workspaceRoot,
                now: fixedNow,
                provider: unexpectedResumeProvider(providerRequests),
                modelProviderSelection: defaultModelProviderSelection,
            });
            const receipt = await service.decideApproval({
                sessionId,
                approvalId: 'approval_permission_call_patch_no_continuation',
                state: 'approved',
                reason: 'desktop approved no continuation',
            });
            const replay = await readReplay(dataDir, sessionId);

            expect(receipt.status).toBe('idle');
            expect(providerRequests).toHaveLength(0);
            await expect(stat(join(workspaceRoot, '.no-continuation.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
            expect(replay.events.map((event) => event.type)).not.toContain('approval.updated');
            expect(replay.events.map((event) => event.type)).not.toContain('approval.resumed');
            expect(replay.events.map((event) => event.type)).not.toContain('file.diff.applied');
            expect(replay.events.map((event) => event.type)).not.toContain('tool.completed');
        } finally {
            await rm(dataDir, { recursive: true, force: true });
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});

function unexpectedResumeProvider(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            yield {
                kind: 'response_failed',
                requestId: request.requestId,
                sequence: 1,
                error: { code: 'unknown', message: 'resume should not have been called', retryable: false },
            };
        },
    };
}
