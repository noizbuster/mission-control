import type { PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createCliPermissionDecision } from './cli-permission-policy.js';

describe('createCliPermissionDecision', () => {
    it('allows named read and scaffold admission actions without allowing effectful tools', () => {
        expect(decisionFor('repo.read').status).toBe('allow');
        expect(decisionFor('repo.list').status).toBe('allow');
        expect(decisionFor('repo.search').status).toBe('allow');
        expect(decisionFor('prompt.submit').status).toBe('allow');
        expect(decisionFor('task.run').status).toBe('allow');
        expect(decisionFor('skill.invoke').status).toBe('allow');
    });

    it('requires approval for effectful coding tools and denies unknown actions', () => {
        expect(decisionFor('file.patch')).toMatchObject({
            status: 'requires_approval',
            reason: 'CLI approval required for file.patch',
        });
        expect(decisionFor('command.run')).toMatchObject({
            status: 'requires_approval',
            reason: 'CLI approval required for command.run',
        });
        expect(decisionFor('filesystem.write')).toMatchObject({
            status: 'deny',
            reason: 'CLI permission policy denies filesystem.write',
        });
    });
});

function decisionFor(action: string) {
    return createCliPermissionDecision(requestFor(action));
}

function requestFor(action: string): PermissionRequest {
    return {
        id: `permission_${action.replace('.', '_')}`,
        action,
        reason: `test ${action}`,
    };
}
