import type { AgentEvent, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createInteractiveApprovalBroker } from './interactive-approval-broker.js';

describe('interactive approval broker', () => {
    it('supports once replies without persisting a future allow rule', async () => {
        const broker = createBroker();
        const first = broker.requestPermission(patchRequest('permission_patch_once'));
        expect(broker.answer('once')).toBe(true);
        await expect(first).resolves.toMatchObject({ status: 'allow' });

        const second = broker.requestPermission(patchRequest('permission_patch_once_again'));
        await waitForPendingApproval(broker);
        expect(broker.answer('deny')).toBe(true);
        await expect(second).resolves.toMatchObject({ status: 'deny' });
    });

    it('supports always replies across matching requests in the same session', async () => {
        const broker = createBroker();
        const first = broker.requestPermission(patchRequest('permission_patch_always'));
        expect(broker.answer('always')).toBe(true);
        await expect(first).resolves.toMatchObject({ status: 'allow' });

        await expect(broker.requestPermission(patchRequest('permission_patch_always_again'))).resolves.toMatchObject({
            status: 'allow',
        });
    });

    it('supports a one-shot primed approval for a previewed request id', async () => {
        const broker = createBroker();
        const first = broker.requestPermission(patchRequest('permission_patch_primed'));
        expect(broker.answer('once')).toBe(true);
        await expect(first).resolves.toMatchObject({ status: 'allow' });

        broker.primeApproval('permission_patch_primed', 'interactive CLI approval');
        await expect(broker.requestPermission(patchRequest('permission_patch_primed'))).resolves.toMatchObject({
            status: 'allow',
            reason: 'interactive CLI approval',
        });

        const third = broker.requestPermission(patchRequest('permission_patch_primed'));
        await waitForPendingApproval(broker);
        expect(broker.answer('deny')).toBe(true);
        await expect(third).resolves.toMatchObject({ status: 'deny' });
    });

    it('emits permission reply events and deny results', async () => {
        const events: AgentEvent[] = [];
        const broker = createBroker(events);
        const pending = broker.requestPermission(patchRequest('permission_patch_deny'));

        expect(broker.answer('deny')).toBe(true);
        await expect(pending).resolves.toMatchObject({ status: 'deny' });
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['permission.requested', 'permission.replied']),
        );
        expect(events.find((event) => event.type === 'permission.replied')?.permissionReply).toMatchObject({
            reply: 'deny',
        });
    });
});

function createBroker(events: AgentEvent[] = []) {
    let output = '';
    return createInteractiveApprovalBroker({
        workspaceRoot: '/workspace',
        sessionId: 'session_cli_permissions',
        modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        output: {
            write: (text: string) => {
                output += text;
            },
            getOutput: () => output,
        },
        emitEvent: (event) => {
            events.push(event);
        },
    });
}

function patchRequest(id: string): PermissionRequest {
    return {
        id,
        action: 'file.patch',
        reason: 'apply patch',
        permission: {
            kind: 'patch',
            patterns: ['src/app.ts'],
            workspaceRoot: '/workspace',
        },
    };
}

async function nextTick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForPendingApproval(broker: ReturnType<typeof createInteractiveApprovalBroker>): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (broker.hasPending()) {
            return;
        }
        await nextTick();
    }
    expect(broker.hasPending()).toBe(true);
}
