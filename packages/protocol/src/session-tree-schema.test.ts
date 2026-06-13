import { describe, expect, it } from 'vitest';
import { AgentEventSchema, AgentEventTypeSchema } from './schema.js';
import { SessionArchiveManifestSchema } from './session-tree.js';

describe('session tree protocol schemas', () => {
    it('parses session tree event metadata on durable agent events', () => {
        const event = AgentEventSchema.parse({
            type: 'session.metadata.updated',
            timestamp: '2026-06-13T01:00:00.000Z',
            sessionId: 'session_tree_protocol',
            sessionTree: {
                kind: 'metadata',
                cwd: '/workspace/mission-control',
                trustedRoot: '/workspace/mission-control',
                workspaceTrust: 'trusted',
                name: 'session tree protocol',
                parentSessionId: 'entry_parent',
            },
        });

        expect(event.sessionTree).toEqual({
            kind: 'metadata',
            cwd: '/workspace/mission-control',
            trustedRoot: '/workspace/mission-control',
            workspaceTrust: 'trusted',
            name: 'session tree protocol',
            parentSessionId: 'entry_parent',
        });
        expect(AgentEventTypeSchema.parse('session.imported')).toBe('session.imported');
    });

    it('parses permission reply events alongside requested permission records', () => {
        const event = AgentEventSchema.parse({
            type: 'permission.replied',
            timestamp: '2026-06-13T02:00:00.000Z',
            sessionId: 'session_existing',
            permissionReply: {
                approvalId: 'approval_existing',
                reply: 'once',
                reason: 'interactive CLI approval',
            },
        });

        expect(event.permissionReply?.reply).toBe('once');
        expect(AgentEventTypeSchema.parse('permission.reply_not_found')).toBe('permission.reply_not_found');
    });

    it('rejects archive manifests whose session ids do not match durable session id rules', () => {
        const baseManifest = {
            schemaVersion: 1,
            sessionId: 'session_valid',
            cwd: '/workspace/mission-control',
            trustedRoot: '/workspace/mission-control',
            createdAt: '2026-06-13T02:00:00.000Z',
        };

        expect(SessionArchiveManifestSchema.parse(baseManifest)).toEqual(baseManifest);
        expect(SessionArchiveManifestSchema.safeParse({ ...baseManifest, sessionId: '../escape' }).success).toBe(false);
        expect(SessionArchiveManifestSchema.safeParse({ ...baseManifest, sessionId: 'nested/session' }).success).toBe(
            false,
        );
    });
});
