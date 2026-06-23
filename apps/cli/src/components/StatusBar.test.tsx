import { describe, expect, it } from 'vitest';
import { formatStatus } from './StatusBar.js';

describe('StatusBar formatStatus', () => {
    it('renders provider and model only when no extras are provided', () => {
        const out = formatStatus({ providerID: 'local', modelID: 'local-echo' });
        expect(out).toBe('provider: local | model: local-echo');
    });

    it('renders variant when provided', () => {
        const out = formatStatus({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variantID: 'thinking-high',
        });
        expect(out).toContain('variant: thinking-high');
    });

    it('renders project dir name from workspaceRoot without branch', () => {
        const out = formatStatus({
            providerID: 'local',
            modelID: 'local-echo',
            workspaceRoot: '/home/user/mission-control',
        });
        expect(out).toContain('project: mission-control');
        expect(out).not.toContain('(');
    });

    it('renders project dir name with git branch when both are provided', () => {
        const out = formatStatus({
            providerID: 'local',
            modelID: 'local-echo',
            workspaceRoot: '/home/user/mission-control',
            gitBranch: 'feature-x',
        });
        expect(out).toContain('project: mission-control (feature-x)');
    });

    it('renders branch only when gitBranch is provided without workspaceRoot', () => {
        const out = formatStatus({
            providerID: 'local',
            modelID: 'local-echo',
            gitBranch: 'main',
        });
        expect(out).toContain('branch: main');
        expect(out).not.toContain('project:');
    });

    it('omits both project and branch when gitBranch is empty string and no workspaceRoot', () => {
        const out = formatStatus({
            providerID: 'local',
            modelID: 'local-echo',
            gitBranch: '',
        });
        expect(out).not.toContain('project:');
        expect(out).not.toContain('branch:');
    });

    it('renders session with display name and id', () => {
        const out = formatStatus({
            providerID: 'local',
            modelID: 'local-echo',
            sessionID: 'session_abc123',
            sessionDisplayName: 'my session',
        });
        expect(out).toContain('session: my session (session_abc123)');
    });

    it('renders session id only when no display name', () => {
        const out = formatStatus({
            providerID: 'local',
            modelID: 'local-echo',
            sessionID: 'session_abc123',
        });
        expect(out).toContain('session: session_abc123');
    });

    it('handles workspaceRoot that ends with a trailing slash', () => {
        const out = formatStatus({
            providerID: 'local',
            modelID: 'local-echo',
            workspaceRoot: '/home/user/mission-control/',
        });
        expect(out).toContain('project: mission-control');
    });

    it('falls back to full path when basename is empty (root path)', () => {
        const out = formatStatus({
            providerID: 'local',
            modelID: 'local-echo',
            workspaceRoot: '/',
        });
        expect(out).toContain('project: /');
    });

    it('renders approval level when provided', () => {
        const out = formatStatus({
            providerID: 'local',
            modelID: 'local-echo',
            approvalLevel: 'aggressive',
        });
        expect(out).toContain('approval: aggressive');
    });

    it('omits approval segment when level is undefined', () => {
        const out = formatStatus({ providerID: 'local', modelID: 'local-echo' });
        expect(out).not.toContain('approval:');
    });
});
