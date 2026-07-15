// allow: SIZE_OK -- HEAD 337 -> current 400 pure LOC; Tauri boundary suite covers credentials sessions and effect resolution
import { AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createTauriDesktopAgentClient } from './agent-client';

describe('tauri desktop agent client', () => {
    it('lists and reads durable sessions through Tauri commands', async () => {
        // Given
        const envelope = AgentEventEnvelopeSchema.parse({
            eventId: 'event_1',
            sequence: 0,
            createdAt: '2026-06-09T00:00:00.000Z',
            sessionId: 'session_readonly',
            durability: 'durable',
            event: {
                type: 'node.completed',
                timestamp: '2026-06-09T00:00:00.000Z',
                sessionId: 'session_readonly',
                message: 'node completed',
                abg: {
                    graphId: 'coding-agent',
                    nodeId: 'answer',
                    signalType: 'success',
                },
            },
        });
        const calls: string[] = [];
        const client = createTauriDesktopAgentClient(async (command, args) => {
            calls.push(command);
            switch (command) {
                case 'list_sessions':
                    return [
                        {
                            sessionId: 'session_readonly',
                            fileName: 'session_readonly.jsonl',
                            state: 'available',
                            eventCount: 1,
                            diagnostics: [],
                            sessionTree: {
                                sessionName: 'Coding parity session',
                                workspaceTrust: 'trusted',
                                trustedRoot: '/workspace/mission-control',
                                entryCount: 1,
                                branchCount: 1,
                            },
                            stats: {
                                eventCount: 1,
                                pendingApprovalCount: 0,
                                blockedRunCount: 0,
                                commandEventCount: 0,
                                diffEventCount: 0,
                                toolOutcomeCount: 0,
                            },
                        },
                    ];
                case 'read_session_events':
                    expect(args).toEqual({ sessionId: 'session_readonly' });
                    return {
                        sessionId: 'session_readonly',
                        state: 'available',
                        contents: 'jsonl',
                        envelopes: [envelope],
                        diagnostics: [],
                    };
                case 'read_session_snapshot':
                    expect(args).toEqual({ sessionId: 'session_readonly' });
                    return {
                        sessionId: 'session_readonly',
                        state: 'available',
                        eventCount: 1,
                        graphIds: ['coding-agent'],
                        diagnostics: [],
                        sessionTree: {
                            sessionName: 'Coding parity session',
                            workspaceTrust: 'trusted',
                            trustedRoot: '/workspace/mission-control',
                            entryCount: 1,
                            branchCount: 1,
                        },
                        stats: {
                            eventCount: 1,
                            pendingApprovalCount: 0,
                            blockedRunCount: 0,
                            commandEventCount: 0,
                            diffEventCount: 0,
                            toolOutcomeCount: 0,
                        },
                    };
                default:
                    throw new Error(`unexpected command ${command}`);
            }
        });

        // When
        const sessions = await client.listSessions();
        const log = await client.readSessionEvents('session_readonly');
        const snapshot = await client.readSessionSnapshot('session_readonly');

        // Then
        expect(calls).toEqual(['list_sessions', 'read_session_events', 'read_session_snapshot']);
        expect(sessions).toEqual([
            {
                sessionId: 'session_readonly',
                fileName: 'session_readonly.jsonl',
                state: 'available',
                eventCount: 1,
                diagnostics: [],
                sessionTree: {
                    sessionName: 'Coding parity session',
                    workspaceTrust: 'trusted',
                    trustedRoot: '/workspace/mission-control',
                    entryCount: 1,
                    branchCount: 1,
                },
                stats: {
                    eventCount: 1,
                    pendingApprovalCount: 0,
                    blockedRunCount: 0,
                    commandEventCount: 0,
                    diffEventCount: 0,
                    toolOutcomeCount: 0,
                },
            },
        ]);
        expect(log.envelopes).toEqual([envelope]);
        expect(snapshot).toMatchObject({
            graphIds: ['coding-agent'],
            sessionTree: {
                workspaceTrust: 'trusted',
                trustedRoot: '/workspace/mission-control',
            },
            stats: {
                eventCount: 1,
                pendingApprovalCount: 0,
            },
        });
    });

    it('rejects malformed Tauri payloads at the client boundary', async () => {
        // Given
        const client = createTauriDesktopAgentClient(async () => ({
            state: 'available',
            contents: 'jsonl',
            envelopes: [{ eventId: 'not-enough' }],
            diagnostics: [],
        }));

        // When / Then
        await expect(client.readSessionEvents('session_bad')).rejects.toThrow();
    });

    it('turns schema-invalid envelopes into visible corrupt diagnostics', async () => {
        // Given
        const client = createTauriDesktopAgentClient(async () => ({
            sessionId: 'session_invalid',
            state: 'available',
            contents: 'jsonl',
            envelopes: [
                {
                    eventId: 'event_1',
                    sequence: 0,
                    createdAt: '2026-06-09T00:00:00.000Z',
                    sessionId: 'session_invalid',
                    durability: 'durable',
                    event: {
                        type: 'task.progress',
                        timestamp: '2026-06-09T00:00:00.000Z',
                        progress: 2,
                        nativeSidecarStatus: 'alien',
                    },
                },
            ],
            diagnostics: [],
        }));

        // When
        const log = await client.readSessionEvents('session_invalid');

        // Then
        expect(log.state).toBe('corrupt');
        expect(log.envelopes).toEqual([]);
        expect(log.diagnostics).toEqual([
            {
                code: 'corrupt_envelope',
                message: 'event envelope failed protocol validation',
                lineNumber: 2,
            },
        ]);
    });

    it('turns log-level invariant violations into visible corrupt diagnostics', async () => {
        // Given
        const firstEnvelope = AgentEventEnvelopeSchema.parse({
            eventId: 'event_1',
            sequence: 1,
            createdAt: '2026-06-09T00:00:00.000Z',
            sessionId: 'session_order',
            durability: 'durable',
            event: {
                type: 'task.completed',
                timestamp: '2026-06-09T00:00:00.000Z',
                sessionId: 'session_order',
                message: 'first',
            },
        });
        const secondEnvelope = AgentEventEnvelopeSchema.parse({
            eventId: 'event_2',
            sequence: 1,
            createdAt: '2026-06-09T00:00:01.000Z',
            sessionId: 'session_order',
            durability: 'durable',
            event: {
                type: 'task.completed',
                timestamp: '2026-06-09T00:00:01.000Z',
                sessionId: 'session_order',
                message: 'second',
            },
        });
        const client = createTauriDesktopAgentClient(async () => ({
            sessionId: 'session_order',
            state: 'available',
            contents: 'jsonl',
            envelopes: [firstEnvelope, secondEnvelope],
            diagnostics: [],
        }));

        // When
        const log = await client.readSessionEvents('session_order');

        // Then
        expect(log.state).toBe('corrupt');
        expect(log.envelopes).toEqual([firstEnvelope]);
        expect(log.diagnostics).toEqual([
            {
                code: 'corrupt_envelope',
                message: 'event sequence is not strictly increasing',
                lineNumber: 3,
            },
        ]);
    });

    it('sends chat and approval command receipts through the Tauri boundary', async () => {
        // Given / When
        const calls: { readonly command: string; readonly args: Record<string, unknown> | undefined }[] = [];
        const client = createTauriDesktopAgentClient(async (command, args) => {
            calls.push({ command, args });
            return {
                sessionId: 'session_write',
                status: command === 'interrupt_run' ? 'interrupted' : 'completed',
                eventsWritten: 1,
            };
        });

        // When
        await client.submitPrompt({
            sessionId: 'session_write',
            prompt: 'desktop prompt',
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        });
        await client.queueFollowUp({
            sessionId: 'session_write',
            prompt: 'queued follow-up',
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        });
        await client.steerRun({
            sessionId: 'session_write',
            prompt: 'steer now',
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        });
        await client.resumeRun({ sessionId: 'session_write' });
        await client.interruptRun({ sessionId: 'session_write', reason: 'manual stop' });
        await client.decideApproval({
            sessionId: 'session_write',
            approvalId: 'approval_permission_call_patch',
            state: 'approved',
            reason: 'looks good',
        });

        // Then
        expect(calls.map((call) => call.command)).toEqual([
            'submit_prompt',
            'queue_follow_up',
            'steer_run',
            'resume_run',
            'interrupt_run',
            'decide_approval',
        ]);
        expect(calls[0]?.args).toEqual({
            input: {
                sessionId: 'session_write',
                prompt: 'desktop prompt',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            },
        });
        expect(calls[5]?.args).toEqual({
            input: {
                sessionId: 'session_write',
                approvalId: 'approval_permission_call_patch',
                state: 'approved',
                reason: 'looks good',
            },
        });
    });

    it('sends an explicit unknown-effect outcome through the Tauri boundary', async () => {
        // Given: a session has a durably unknown command effect.
        const calls: { readonly command: string; readonly args: Record<string, unknown> | undefined }[] = [];
        const client = createTauriDesktopAgentClient(async (command, args) => {
            calls.push({ command, args });
            if (command === 'get_approval_effect') {
                return unknownEffectRecord();
            }
            if (command === 'resolve_approval_effect') {
                return { sessionId: 'session_write', status: 'resolved', effect: unknownEffectRecord('completed') };
            }
            throw new Error(`unexpected command ${command}`);
        });

        // When: an operator inspects then records the observed outcome.
        const effect = await client.getApprovalEffect({
            sessionId: 'session_write',
            approvalId: 'approval_effect',
        });
        const receipt = await client.resolveApprovalEffect({
            sessionId: 'session_write',
            approvalId: 'approval_effect',
            outcome: 'completed',
        });

        // Then: the client uses recovery commands, never an approval decision command.
        expect(effect).toMatchObject({ state: 'unknown' });
        expect(effect).not.toHaveProperty('outcome');
        expect(receipt).toMatchObject({ status: 'resolved', effect: { outcome: 'completed' } });
        expect(calls).toEqual([
            {
                command: 'get_approval_effect',
                args: { input: { sessionId: 'session_write', approvalId: 'approval_effect' } },
            },
            {
                command: 'resolve_approval_effect',
                args: {
                    input: {
                        sessionId: 'session_write',
                        approvalId: 'approval_effect',
                        outcome: 'completed',
                    },
                },
            },
        ]);
    });

    it('lists and saves provider credentials through the Tauri boundary', async () => {
        // Given
        const calls: { readonly command: string; readonly args: Record<string, unknown> | undefined }[] = [];
        const client = createTauriDesktopAgentClient(async (command, args) => {
            calls.push({ command, args });
            if (command === 'list_provider_credentials') {
                return [];
            }
            if (command === 'save_provider_credential') {
                return {
                    providerID: 'openai',
                    authenticated: true,
                    maskedCredential: 'sk-d...1234',
                };
            }
            throw new Error(`unexpected command ${command}`);
        });

        // When
        const before = await client.listProviderCredentials();
        const saved = await client.saveProviderCredential({
            providerID: 'openai',
            modelID: 'gpt-4.1',
            apiKey: 'sk-desktop-secret-1234',
        });

        // Then
        expect(before).toEqual([]);
        expect(saved).toEqual({
            providerID: 'openai',
            authenticated: true,
            maskedCredential: 'sk-d...1234',
        });
        expect(calls).toEqual([
            { command: 'list_provider_credentials', args: undefined },
            {
                command: 'save_provider_credential',
                args: {
                    input: {
                        providerID: 'openai',
                        modelID: 'gpt-4.1',
                        apiKey: 'sk-desktop-secret-1234',
                    },
                },
            },
        ]);
    });

    it('exposes session credential and write action methods on the Tauri client boundary', () => {
        // Given / When
        const client = createTauriDesktopAgentClient(async () => ({
            sessionId: 'session_write',
            status: 'completed',
            eventsWritten: 0,
        }));

        // Then
        expect(Object.keys(client).sort()).toEqual([
            'decideApproval',
            'getApprovalEffect',
            'interruptRun',
            'listProviderCredentials',
            'listSessions',
            'queueFollowUp',
            'readSessionEvents',
            'readSessionSnapshot',
            'resolveApprovalEffect',
            'resumeRun',
            'saveProviderCredential',
            'steerRun',
            'submitPrompt',
        ]);
    });
});

function unknownEffectRecord(outcome?: 'completed' | 'failed') {
    return {
        state: 'unknown',
        requestedAt: '2026-07-15T03:00:00.000Z',
        executionToken: 'execution_token',
        leaseExpiresAt: '2026-07-15T03:01:00.000Z',
        executingAt: '2026-07-15T03:00:01.000Z',
        unknownAt: '2026-07-15T03:02:00.000Z',
        ...(outcome === undefined ? {} : { outcome, resolvedAt: '2026-07-15T03:03:00.000Z' }),
        effect: {
            sessionId: 'session_write',
            approvalId: 'approval_effect',
            runId: 'run_effect',
            toolCallId: 'call_effect',
            toolName: 'command.run',
            argumentsJson: '{"command":"node"}',
            workspaceRoot: '/workspace',
        },
    };
}
