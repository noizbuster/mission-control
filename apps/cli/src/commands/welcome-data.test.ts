import type { Skill } from '@mission-control/core';
import { describe, expect, it } from 'vitest';
import type { CliSessionCatalogEntry } from './session-catalog.js';
import {
    buildWelcomeLspServers,
    type GatherWelcomeDataDeps,
    gatherWelcomeData,
    selectProjectSkills,
    toWelcomeMcpServer,
    toWelcomeSession,
    WELCOME_SESSION_LIMIT,
    type WelcomeData,
    type WelcomeSession,
} from './welcome-data.js';

function makeCatalogEntry(overrides: Partial<CliSessionCatalogEntry> = {}): CliSessionCatalogEntry {
    return {
        sessionId: 'ses_abc123',
        status: 'idle',
        eventCount: 10,
        messageCount: 5,
        trustStatus: 'unknown',
        diagnostics: [],
        ...overrides,
    };
}

describe('toWelcomeMcpServer', () => {
    it('collapses a local server to type "stdio"', () => {
        const result = toWelcomeMcpServer({
            name: 'stdio-server',
            scope: 'project',
            type: 'local',
            enabled: true,
            command: ['node', 'server.js'],
        });
        expect(result).toEqual({ name: 'stdio-server', type: 'stdio', scope: 'project' });
    });

    it('keeps a remote server as type "remote"', () => {
        const result = toWelcomeMcpServer({
            name: 'remote-server',
            scope: 'user',
            type: 'remote',
            enabled: true,
            url: 'https://example.com/mcp',
        });
        expect(result).toEqual({ name: 'remote-server', type: 'remote', scope: 'user' });
    });
});

describe('selectProjectSkills', () => {
    const skills: readonly Skill[] = [
        {
            name: 'zebra',
            description: 'z',
            disableModelInvocation: false,
            filePath: '/a/SKILL.md',
            baseDir: '/a',
            sourceInfo: { scope: 'project', scopeId: 'project-agents', sourceDir: '/a' },
        },
        {
            name: 'alpha',
            description: '',
            disableModelInvocation: false,
            filePath: '/b/SKILL.md',
            baseDir: '/b',
            sourceInfo: { scope: 'project', scopeId: 'project-mctrl', sourceDir: '/b' },
        },
        {
            name: 'global-skill',
            description: 'g',
            disableModelInvocation: false,
            filePath: '/c/SKILL.md',
            baseDir: '/c',
            sourceInfo: { scope: 'user', scopeId: 'global-user', sourceDir: '/c' },
        },
    ];
    it('keeps only project-scoped skills and sorts by name', () => {
        const result = selectProjectSkills(skills);
        expect(result).toHaveLength(2);
        expect(result[0]?.name).toBe('alpha');
        expect(result[1]?.name).toBe('zebra');
        expect('description' in (result[0] ?? {})).toBe(false);
        expect(result[1]?.description).toBe('z');
    });

    it('returns empty for an all-user-scope list', () => {
        const userOnly: readonly Skill[] = [skills[2]!];
        expect(selectProjectSkills(userOnly)).toEqual([]);
    });
});

describe('buildWelcomeLspServers', () => {
    it('marks servers as available when their languageId appears in the probe', () => {
        const catalog = [
            { languageId: 'typescript', extensions: ['.ts'], command: 'typescript-language-server' },
            { languageId: 'go', extensions: ['.go'], command: 'gopls' },
        ];
        const available = [{ languageId: 'typescript', extensions: ['.ts'], command: 'typescript-language-server' }];
        const result = buildWelcomeLspServers(catalog, available);
        expect(result).toEqual([
            { languageId: 'typescript', command: 'typescript-language-server', available: true },
            { languageId: 'go', command: 'gopls', available: false },
        ]);
    });

    it('returns an empty list for an empty catalog', () => {
        expect(buildWelcomeLspServers([], [])).toEqual([]);
    });
});

describe('toWelcomeSession', () => {
    it('keeps updatedAt when present', () => {
        const entry = makeCatalogEntry({ sessionId: 'ses_xyz', updatedAt: '2026-06-30T00:00:00Z', messageCount: 7 });
        expect(toWelcomeSession(entry)).toEqual({
            sessionId: 'ses_xyz',
            updatedAt: '2026-06-30T00:00:00Z',
            messageCount: 7,
        });
    });

    it('omits updatedAt when absent', () => {
        const entry = makeCatalogEntry({ sessionId: 'ses_xyz', messageCount: 3, updatedAt: undefined });
        const result = toWelcomeSession(entry) as WelcomeSession;
        expect(result.sessionId).toBe('ses_xyz');
        expect(result.messageCount).toBe(3);
        expect('updatedAt' in result).toBe(false);
    });
});

describe('gatherWelcomeData integration', () => {
    it('returns a fully-formed snapshot and never throws on a missing workspace', async () => {
        const deps: GatherWelcomeDataDeps = {
            detectLspServers: async () => [
                { languageId: 'typescript', extensions: ['.ts'], command: 'typescript-language-server' },
            ],
        };
        const data: WelcomeData = await gatherWelcomeData({ deps });
        expect(data.version.length).toBeGreaterThan(0);
        expect(data.defaultModel).toEqual({ providerID: 'local', modelID: 'local-echo' });
        expect(Array.isArray(data.mcpServers)).toBe(true);
        expect(Array.isArray(data.projectSkills)).toBe(true);
        expect(Array.isArray(data.recentSessions)).toBe(true);
        expect(data.lspServers.some((server) => server.languageId === 'typescript')).toBe(true);
    });

    it('falls back to an empty LSP list when the probe rejects', async () => {
        const deps: GatherWelcomeDataDeps = {
            detectLspServers: async () => {
                throw new Error('probe failure');
            },
        };
        const data = await gatherWelcomeData({ deps });
        expect(data.lspServers.length).toBeGreaterThan(0);
        expect(data.lspServers.every((server) => server.available === false)).toBe(true);
    });

    it('respects the WELCOME_SESSION_LIMIT constant', () => {
        expect(WELCOME_SESSION_LIMIT).toBe(3);
    });
});
