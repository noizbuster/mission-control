import { defaultModelProviderSelection } from '@mission-control/config';
import type { AgentEvent } from '@mission-control/protocol';
import { expect } from 'vitest';
import { createDesktopSessionCommandService } from './desktop-session-commands.js';
import { filePatchCall, fixedNow, readReplay } from './desktop-session-commands-test-support.js';
import {
    createAbortableProvider,
    createBlockedThenContinuationProvider,
    createReleasingProvider,
    deferred,
    requestMessageContents,
} from './desktop-session-run-owner-provider.test-support.js';
import { createDeterministicProvider } from './providers/deterministic-provider.js';
import type { ProviderTurnRequest } from './providers/provider-turn-types.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function assertAttachesToExistingRunOwner(): Promise<void> {
    // Given
    const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-owner-attach-'));
    const sessionId = 'session_desktop_owner_attach';
    const started = deferred<void>();
    const cleanupFinished = deferred<void>();
    const requests: ProviderTurnRequest[] = [];
    let iteratorClosed = false;
    let providerSignal: AbortSignal | undefined;
    const service = createDesktopSessionCommandService({
        dataDir,
        workspaceRoot: dataDir,
        now: fixedNow,
        provider: createAbortableProvider({
            requests,
            started,
            cleanupFinished,
            markClosed: () => {
                iteratorClosed = true;
            },
            captureSignal: (signal) => {
                providerSignal = signal;
            },
        }),
    });

    try {
        // When
        const submitted = service.submitPrompt({
            sessionId,
            prompt: 'interrupt the active desktop run',
            modelProviderSelection: defaultModelProviderSelection,
        });
        await started.promise;
        const interrupted = service.interruptRun({ sessionId, reason: 'desktop interrupt' });
        await Promise.resolve();
        cleanupFinished.resolve();
        const [submitReceipt, interruptReceipt] = await Promise.all([submitted, interrupted]);
        const replay = await readReplay(dataDir, sessionId);

        // Then
        expect(submitReceipt.status).toBe('interrupted');
        expect(interruptReceipt.status).toBe('interrupted');
        expect(iteratorClosed).toBe(true);
        expect(providerSignal?.aborted).toBe(true);
        expect(requests).toHaveLength(1);
        expect(countEvents(replay.events, 'run.started')).toBe(1);
        expect(runCommands(replay.events)).toEqual(expect.arrayContaining(['run', 'interrupt']));
    } finally {
        await rm(dataDir, { recursive: true, force: true });
    }
}

export async function assertDoesNotStartSecondActiveRun(): Promise<void> {
    // Given
    const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-owner-duplicate-'));
    const sessionId = 'session_desktop_owner_duplicate';
    const started = deferred<void>();
    const release = deferred<void>();
    const requests: ProviderTurnRequest[] = [];
    const service = createDesktopSessionCommandService({
        dataDir,
        workspaceRoot: dataDir,
        now: fixedNow,
        provider: createReleasingProvider(requests, started, release),
    });

    try {
        // When
        const submitted = service.submitPrompt({
            sessionId,
            prompt: 'complete one desktop run',
            modelProviderSelection: defaultModelProviderSelection,
        });
        await started.promise;
        const resumed = service.resumeRun({ sessionId });
        release.resolve();
        const [submitReceipt, resumeReceipt] = await Promise.all([submitted, resumed]);
        const replay = await readReplay(dataDir, sessionId);

        // Then
        expect(submitReceipt.status).toBe('completed');
        expect(resumeReceipt.status).toBe('completed');
        expect(requests).toHaveLength(1);
        expect(requestMessageContents(requests[0])).toEqual(['complete one desktop run']);
        expect(countEvents(replay.events, 'run.started')).toBe(1);
        expect(runCommands(replay.events)).toEqual(expect.arrayContaining(['run', 'resume']));
    } finally {
        await rm(dataDir, { recursive: true, force: true });
    }
}

export async function assertResumesBlockedWorkAfterReopeningStore(): Promise<void> {
    // Given
    const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-owner-restart-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-owner-restart-workspace-'));
    const sessionId = 'session_desktop_owner_restart';
    const requests: ProviderTurnRequest[] = [];
    const provider = createBlockedThenContinuationProvider(requests);
    const selection = { ...defaultModelProviderSelection, variantID: 'desktop-owner-restart' };
    const firstProcess = createDesktopSessionCommandService({
        dataDir,
        workspaceRoot,
        now: fixedNow,
        provider,
    });

    try {
        await firstProcess.submitPrompt({
            sessionId,
            prompt: 'patch after durable restart',
            modelProviderSelection: selection,
        });
        const restartedProcess = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot,
            now: fixedNow,
            provider,
        });

        // When
        const receipt = await restartedProcess.decideApproval({
            sessionId,
            approvalId: 'approval_permission_call_patch_restart_owner',
            state: 'approved',
            reason: 'desktop approved after restart',
        });
        const written = await readFile(join(workspaceRoot, '.mission-control-owner-restart.txt'), 'utf8');
        const replay = await readReplay(dataDir, sessionId);

        // Then
        expect(receipt.status).toBe('completed');
        expect(written).toBe('owner restart approved\n');
        expect(requests).toHaveLength(2);
        expect(requests[1]).toMatchObject({
            providerID: selection.providerID,
            modelID: selection.modelID,
            variantID: selection.variantID,
        });
        expect(requests[1]?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
        expect(replay.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['approval.resumed', 'tool.completed', 'run.completed']),
        );
    } finally {
        await rm(dataDir, { recursive: true, force: true });
        await rm(workspaceRoot, { recursive: true, force: true });
    }
}

export async function assertInterruptPreservesApprovalDiagnostics(): Promise<void> {
    // Given
    const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-owner-approval-interrupt-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-owner-approval-workspace-'));
    const sessionId = 'session_desktop_owner_approval_interrupt';
    const service = createDesktopSessionCommandService({
        dataDir,
        workspaceRoot,
        now: fixedNow,
        provider: createDeterministicProvider([
            filePatchCall('call_patch_approval_interrupt', '.mission-control-approval-interrupt.txt', 'pending write'),
            { kind: 'response_completed', content: 'approval required' },
        ]),
    });

    try {
        await service.submitPrompt({
            sessionId,
            prompt: 'patch should remain pending after interrupt',
            modelProviderSelection: defaultModelProviderSelection,
        });

        // When
        const receipt = await service.interruptRun({ sessionId, reason: 'desktop stop while approval is pending' });
        const replay = await readReplay(dataDir, sessionId);

        // Then
        expect(receipt.status).not.toBe('failed');
        expect(receipt.eventsWritten).toBeGreaterThan(0);
        expect(replay.approvals).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    approvalId: 'approval_permission_call_patch_approval_interrupt',
                    state: 'pending',
                }),
            ]),
        );
        expect(replay.events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['approval.requested', 'run.blocked', 'run.command.received']),
        );
    } finally {
        await rm(dataDir, { recursive: true, force: true });
        await rm(workspaceRoot, { recursive: true, force: true });
    }
}

function countEvents(events: readonly AgentEvent[], type: AgentEvent['type']): number {
    return events.filter((event) => event.type === type).length;
}

function runCommands(events: readonly AgentEvent[]): readonly string[] {
    return events.flatMap((event) =>
        event.type === 'run.command.received' && event.run?.command !== undefined ? [event.run.command] : [],
    );
}
