import type { PermissionKind, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { cliAllowsAction, createCliPermissionDecision } from './cli-permission-policy';

type ProductionPermissionAction = {
    readonly action: string;
    readonly kind: PermissionKind;
};

const PRODUCTION_PERMISSION_ACTIONS = [
    { action: 'repo.read', kind: 'read' },
    { action: 'repo.list', kind: 'read' },
    { action: 'repo.search', kind: 'read' },
    { action: 'read', kind: 'read' },
    { action: 'ls', kind: 'read' },
    { action: 'grep', kind: 'read' },
    { action: 'find', kind: 'read' },
    { action: 'repo.read.tagged', kind: 'read' },
    { action: 'glob', kind: 'read' },
    { action: 'ast_edit apply', kind: 'edit' },
    { action: 'file.edit', kind: 'edit' },
    { action: 'file.write', kind: 'write' },
    { action: 'file.patch', kind: 'patch' },
    { action: 'hashline_edit', kind: 'edit' },
    { action: 'command.run', kind: 'bash' },
    { action: 'bash.run', kind: 'bash' },
    { action: 'interactive_bash', kind: 'bash' },
    { action: 'eval', kind: 'bash' },
    { action: 'monitor_start', kind: 'bash' },
    { action: 'webfetch', kind: 'network' },
    { action: 'mcp', kind: 'network' },
    { action: 'browser', kind: 'network' },
    { action: 'github', kind: 'network' },
    { action: 'generate_image', kind: 'write' },
    { action: 'tts', kind: 'write' },
    { action: 'look_at', kind: 'network' },
    { action: 'inspect_image', kind: 'network' },
    { action: 'task', kind: 'subagent' },
    { action: 'lsp_rename', kind: 'edit' },
] satisfies readonly ProductionPermissionAction[];

const UNSUPPORTED_CLI_ACTIONS = ['shell.session', 'ssh'] as const;

describe('CLI production permission action completeness', () => {
    it.each(PRODUCTION_PERMISSION_ACTIONS)('admits the exact $action source action', async ({ action, kind }) => {
        // Given
        const request = permissionRequest(action, kind);

        // When
        const decision = await createCliPermissionDecision(request);

        // Then
        expect(cliAllowsAction(action)).toBe(true);
        expect(decision.status).toBe(kind === 'read' ? 'allow' : 'requires_approval');
    });

    it.each(UNSUPPORTED_CLI_ACTIONS)('keeps unsupported $action transport actions denied', async (action) => {
        // Given
        const request = permissionRequest(action, 'network');

        // When
        const decision = await createCliPermissionDecision(request);

        // Then
        expect(cliAllowsAction(action)).toBe(false);
        expect(decision.status).toBe('deny');
    });
});

function permissionRequest(action: string, kind: PermissionKind): PermissionRequest {
    return {
        id: `permission_${action.replaceAll(/[^a-z0-9]+/g, '_')}`,
        action,
        reason: `Task 13 inventory: ${action}`,
        permission: {
            kind,
            patterns: ['task-13-fixture'],
            workspaceRoot: '/tmp/workspace',
        },
    };
}
