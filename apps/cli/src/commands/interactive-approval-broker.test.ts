import { PermissionSession } from '@mission-control/core';
import type { AgentEvent, PermissionRequest } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInteractiveApprovalBroker } from './interactive-approval-broker.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('interactive approval broker', () => {
    // Isolate the file-backed PermissionRuleStore so an "always" (persist:true) reply cannot leak
    // into the user's real permission store or across tests.
    let previousDataDir: string | undefined;
    beforeEach(() => {
        previousDataDir = process.env['MCTRL_DATA_DIR'];
        process.env['MCTRL_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'mctrl-broker-'));
    });
    afterEach(() => {
        if (previousDataDir === undefined) {
            delete process.env['MCTRL_DATA_DIR'];
        } else {
            process.env['MCTRL_DATA_DIR'] = previousDataDir;
        }
    });

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

    // Regression: a session-scoped "always" approval must survive broker recreation, because the
    // interactive chat builds one broker per prompt turn over a single shared PermissionSession.
    // Before the fix each turn made its own session and "this session" approvals vanished.
    it('preserves a session-scoped always approval across brokers sharing a permission session', async () => {
        const shared = new PermissionSession();
        const turnOne = createInteractiveApprovalBroker(baseBrokerOptions(), shared);
        const first = turnOne.requestPermission(patchRequest('permission_patch_session_shared'));
        expect(turnOne.answer('session')).toBe(true);
        await expect(first).resolves.toMatchObject({ status: 'allow' });

        const turnTwo = createInteractiveApprovalBroker(baseBrokerOptions(), shared);
        await expect(turnTwo.requestPermission(patchRequest('permission_patch_session_shared'))).resolves.toMatchObject(
            { status: 'allow' },
        );
    });
});

function createBroker(events: AgentEvent[] = []) {
    return createInteractiveApprovalBroker(baseBrokerOptions(events));
}

function baseBrokerOptions(events: AgentEvent[] = []) {
    let output = '';
    return {
        workspaceRoot: '/workspace',
        sessionId: 'session_cli_permissions',
        modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        output: {
            write: (text: string) => {
                output += text;
            },
            getOutput: () => output,
        },
        emitEvent: (event: AgentEvent) => {
            events.push(event);
        },
    };
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
