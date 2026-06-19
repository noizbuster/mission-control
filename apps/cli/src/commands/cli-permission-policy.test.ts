import type { PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { cliAllowsAction, createCliPermissionDecision } from './cli-permission-policy.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const knownSafePatchPath = '.mctrl-known-safe-automation-patch.txt';

describe('cli permission policy', () => {
    it('scopes bash.run through the CLI permission policy', async () => {
        const request = bashRunRequest();

        expect(cliAllowsAction('bash.run')).toBe(true);

        const decision = await createCliPermissionDecision(request);

        expect(decision.status).toBe('requires_approval');
        expect(decision.reason).toContain('bash.run');
    });

    it('allows the read-class glob action and scopes webfetch to requires_approval', async () => {
        expect(cliAllowsAction('glob')).toBe(true);
        expect(cliAllowsAction('webfetch')).toBe(true);

        const globDecision = await createCliPermissionDecision({
            id: 'permission_glob',
            action: 'glob',
            reason: 'glob within workspace: .',
            permission: {
                kind: 'read',
                patterns: ['.'],
                workspaceRoot: '/tmp/workspace',
            },
        });
        expect(globDecision.status).toBe('allow');

        const webfetchDecision = await createCliPermissionDecision({
            id: 'permission_webfetch',
            action: 'webfetch',
            reason: 'fetch url: https://example.test/docs',
            permission: {
                kind: 'network',
                patterns: ['https://example.test/docs'],
                workspaceRoot: '/tmp/workspace',
            },
        });
        expect(webfetchDecision.status).toBe('requires_approval');
        expect(webfetchDecision.reason).toContain('webfetch');
    });

    it('admits the task action and scopes it to requires_approval (subagent kind)', async () => {
        expect(cliAllowsAction('task')).toBe(true);

        const decision = await createCliPermissionDecision({
            id: 'permission_task',
            action: 'task',
            reason: 'delegate sub-task: summarize deps',
            permission: {
                kind: 'subagent',
                patterns: ['summarize deps'],
                workspaceRoot: '/tmp/workspace',
            },
        });
        expect(decision.status).toBe('requires_approval');
        expect(decision.reason).toContain('task');
    });

    it('denies unknown CLI actions', async () => {
        const request: PermissionRequest = {
            id: 'permission_unknown',
            action: 'bash.unknown',
            reason: 'unknown action',
            permission: {
                kind: 'bash',
                patterns: ['printf ok'],
                workspaceRoot: '/tmp/workspace',
            },
        };

        expect(cliAllowsAction(request.action)).toBe(false);

        const decision = await createCliPermissionDecision(request);

        expect(decision.status).toBe('deny');
    });

    it('does not auto-approve persisted always rules for headless effectful tools', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-cli-permission-policy-'));
        const workspaceRoot = join(dataDir, 'workspace');
        await mkdir(join(dataDir, 'trust'), { recursive: true });
        await mkdir(workspaceRoot, { recursive: true });
        await writeFile(
            join(dataDir, 'trust', 'permission-rules.json'),
            JSON.stringify(
                {
                    version: 1,
                    rules: [
                        { permission: 'patch', pattern: '.blocked.txt', decision: 'always', workspaceRoot },
                        { permission: 'write', pattern: '.blocked.txt', decision: 'always', workspaceRoot },
                        {
                            permission: 'bash',
                            pattern: 'node --eval console.log(1)',
                            decision: 'always',
                            workspaceRoot,
                        },
                    ],
                },
                null,
                2,
            ),
            'utf8',
        );
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const patchDecision = await createCliPermissionDecision({
            id: 'permission_patch_always',
            action: 'file.patch',
            reason: 'apply patch to .blocked.txt',
            permission: {
                kind: 'patch',
                patterns: ['.blocked.txt'],
                workspaceRoot,
            },
        });
        const writeDecision = await createCliPermissionDecision({
            id: 'permission_write_always',
            action: 'file.write',
            reason: 'write .blocked.txt',
            permission: {
                kind: 'write',
                patterns: ['.blocked.txt'],
                workspaceRoot,
            },
        });
        const commandDecision = await createCliPermissionDecision({
            id: 'permission_command_always',
            action: 'command.run',
            reason: 'run node --eval console.log(1)',
            permission: {
                kind: 'bash',
                patterns: ['node --eval console.log(1)'],
                workspaceRoot,
            },
        });

        expect(patchDecision.status).toBe('requires_approval');
        expect(writeDecision.status).toBe('requires_approval');
        expect(commandDecision.status).toBe('requires_approval');
    });

    it('does not auto-approve arbitrary file.patch under the test-only safe patch automation policy', async () => {
        const decision = await createCliPermissionDecision(
            {
                id: 'permission_patch_arbitrary_automation',
                action: 'file.patch',
                reason: 'apply patch to .mctrl-arbitrary.txt',
                permission: {
                    kind: 'patch',
                    patterns: ['.mctrl-arbitrary.txt'],
                    workspaceRoot: '/tmp/workspace',
                },
            },
            {
                automationPolicy: 'test-only-allow-known-safe-patch',
            },
        );

        expect(decision.status).toBe('requires_approval');
        expect(decision.reason).toContain('file.patch');
    });

    it('allows the explicit known-safe file.patch fixture under the test-only automation policy', async () => {
        const decision = await createCliPermissionDecision(
            {
                id: 'permission_patch_known_safe_automation',
                action: 'file.patch',
                reason: `apply patch to ${knownSafePatchPath}`,
                permission: {
                    kind: 'patch',
                    patterns: [knownSafePatchPath],
                    workspaceRoot: '/tmp/workspace',
                },
            },
            {
                automationPolicy: 'test-only-allow-known-safe-patch',
            },
        );

        expect(decision.status).toBe('allow');
        expect(decision.reason).toBe('test-only automation allows known safe patch');
    });
});

function bashRunRequest(): PermissionRequest {
    return {
        id: 'permission_bash_run',
        action: 'bash.run',
        reason: 'run trusted bash',
        permission: {
            kind: 'bash',
            patterns: ['printf ok'],
            workspaceRoot: '/tmp/workspace',
        },
    };
}
