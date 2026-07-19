import { PermissionSession } from '@mission-control/core';
import type { AgentEvent, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createInteractiveApprovalBroker } from './interactive-approval-broker';

describe('interactive approval terminal sanitization', () => {
    it('sanitizes approval action and reason only at the display boundary', async () => {
        // Given
        const recording = createApprovalRecording();
        const rawPattern = 'node --check\u202e';
        const request: PermissionRequest = {
            id: 'permission_terminal_controls',
            action: 'command.run\u001b[31m',
            reason: 'run sk-approvaldisplay123\u001b]52;c;payload\u0007',
            permission: { kind: 'bash', patterns: [rawPattern], workspaceRoot: '/workspace' },
        };
        const broker = createInteractiveApprovalBroker(recording.options);

        // When
        const pending = broker.requestPermission(request);
        await waitForPendingApproval(broker);
        broker.answer('deny');
        await pending;

        // Then
        expect(recording.approvals).toEqual([
            {
                action: 'command.run\\u{001B}[31m',
                reason: 'run [REDACTED_CREDENTIAL]\\u{001B}]52;c;payload\\u{0007}',
            },
        ]);
        expect(recording.writes.join('')).toBe(
            'Approve command.run\\u{001B}[31m? [once/always/deny]:\nDenied command.run\\u{001B}[31m\n',
        );
        const permissionEvent = recording.events.find((event) => event.type === 'permission.requested');
        expect(permissionEvent?.permissionRequest).toMatchObject({ permission: { patterns: [rawPattern] } });
    });

    it('matches raw permission patterns before any display sanitization', async () => {
        // Given
        const recording = createApprovalRecording();
        const rawPattern = 'node --check\u202e';
        const permissionSession = new PermissionSession({
            builtInRules: [{ permission: 'bash', pattern: rawPattern, decision: 'always' }],
        });
        const broker = createInteractiveApprovalBroker(recording.options, permissionSession);

        // When
        const decision = await broker.requestPermission({
            id: 'permission_raw_match',
            action: 'command.run',
            reason: 'run exact command',
            permission: { kind: 'bash', patterns: [rawPattern], workspaceRoot: '/workspace' },
        });

        // Then
        expect(decision).toMatchObject({ status: 'allow', matchedRule: { pattern: rawPattern } });
        expect(recording.writes).toEqual([]);
        expect(recording.approvals).toEqual([]);
    });
});

function createApprovalRecording(): {
    readonly options: {
        readonly workspaceRoot: string;
        readonly sessionId: string;
        readonly modelProviderSelection: { readonly providerID: string; readonly modelID: string };
        readonly output: {
            readonly write: (text: string) => void;
            readonly showApproval: (action: string, reason: string) => void;
        };
        readonly emitEvent: (event: AgentEvent) => void;
    };
    readonly events: AgentEvent[];
    readonly writes: string[];
    readonly approvals: { readonly action: string; readonly reason: string }[];
} {
    const events: AgentEvent[] = [];
    const writes: string[] = [];
    const approvals: { readonly action: string; readonly reason: string }[] = [];
    return {
        options: {
            workspaceRoot: '/workspace',
            sessionId: 'session_cli_terminal_permissions',
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            output: {
                write: (text) => writes.push(text),
                showApproval: (action, reason) => approvals.push({ action, reason }),
            },
            emitEvent: (event) => events.push(event),
        },
        events,
        writes,
        approvals,
    };
}

async function waitForPendingApproval(broker: ReturnType<typeof createInteractiveApprovalBroker>): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (broker.hasPending()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(broker.hasPending()).toBe(true);
}
