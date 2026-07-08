import { terminalDisplayWidth } from '@mission-control/tui';
import { describe, expect, it, vi } from 'vitest';
import type {
    WelcomeData,
    WelcomeLspServer,
    WelcomeMcpServer,
    WelcomeSession,
    WelcomeSkill,
} from '../state/welcome-data-types.js';
import {
    buildProjectDescriptor,
    formatLspGlyphs,
    formatMcpServerRow,
    formatModelLine,
    formatRelativeTime,
    formatSessionRow,
    formatSkillRow,
    formatWelcomeHint,
    padToWidth,
    sectionDividerRule,
    truncateSessionId,
    welcomeRowBudgetPlan,
    welcomeWidthBudget,
} from './WelcomeScreen.js';

vi.mock('@mission-control/tui', async () => await import('../terminal-text.js'));

const NOW = new Date('2026-07-01T12:00:00Z');
const isoMinutesAgo = (mins: number): string => new Date(NOW.getTime() - mins * 60_000).toISOString();

function makeData(overrides: Partial<WelcomeData> = {}): WelcomeData {
    return {
        version: '0.1.0',
        defaultModel: { providerID: 'local', modelID: 'local-echo' },
        mcpServers: [],
        projectSkills: [],
        lspServers: [],
        recentSessions: [],
        ...overrides,
    };
}

describe('padToWidth', () => {
    it('pads short strings with trailing spaces', () => {
        expect(padToWidth('hi', 5)).toBe('hi   ');
    });

    it('truncates long strings with an ellipsis', () => {
        expect(padToWidth('hello world', 8)).toBe('hello w\u2026');
    });

    it('returns the input unchanged when it already matches the width', () => {
        expect(padToWidth('exact', 5)).toBe('exact');
    });

    it('degrades gracefully on width <= 1 with truncation', () => {
        expect(padToWidth('abc', 1)).toBe('a');
    });
});

describe('truncateSessionId', () => {
    it('returns the input when shorter than the limit', () => {
        expect(truncateSessionId('ses_short', 16)).toBe('ses_short');
    });

    it('appends an ellipsis when truncating', () => {
        expect(truncateSessionId('ses_very_long_identifier_xyz', 10)).toBe('ses_very_\u2026');
    });

    it('honours a custom max length', () => {
        expect(truncateSessionId('abcdefghijklmnopqrstuvwxyz', 5)).toBe('abcd\u2026');
    });
});

describe('formatRelativeTime', () => {
    it('returns undefined for undefined input', () => {
        expect(formatRelativeTime(undefined, NOW)).toBeUndefined();
    });

    it('returns undefined for an unparseable timestamp', () => {
        expect(formatRelativeTime('not-a-date', NOW)).toBeUndefined();
    });

    it('returns "just now" for <60s', () => {
        expect(formatRelativeTime(isoMinutesAgo(0.5), NOW)).toBe('just now');
    });

    it('returns "Nm ago" for <60m', () => {
        expect(formatRelativeTime(isoMinutesAgo(5), NOW)).toBe('5m ago');
    });

    it('returns "Nh ago" for <24h', () => {
        expect(formatRelativeTime(isoMinutesAgo(60 * 3), NOW)).toBe('3h ago');
    });

    it('returns "yesterday" for <48h', () => {
        expect(formatRelativeTime(isoMinutesAgo(60 * 26), NOW)).toBe('yesterday');
    });

    it('returns "Nd ago" for <7d', () => {
        expect(formatRelativeTime(isoMinutesAgo(60 * 24 * 3), NOW)).toBe('3d ago');
    });

    it('falls back to ISO date for >=7d', () => {
        const old = new Date(NOW.getTime() - 60 * 24 * 10 * 60_000).toISOString();
        expect(formatRelativeTime(old, NOW)).toBe(old.slice(0, 10));
    });
});

describe('formatModelLine', () => {
    it('formats provider / model with a "default model" label', () => {
        const data = makeData();
        expect(formatModelLine(data)).toEqual({ label: 'default model', value: 'local / local-echo' });
    });
});

describe('formatMcpServerRow', () => {
    it('combines type and scope into one value', () => {
        const server: WelcomeMcpServer = { name: 'context7', type: 'remote', scope: 'user' };
        expect(formatMcpServerRow(server)).toEqual({ label: 'context7', value: 'remote (user)' });
    });
});

describe('formatSkillRow', () => {
    it('keeps the full description when short enough', () => {
        const skill: WelcomeSkill = {
            name: 'impeccable',
            description: 'Use for redesigns.',
            scopeId: 'project-mctrl',
        };
        expect(formatSkillRow(skill)).toEqual({ label: 'impeccable', value: 'Use for redesigns.' });
    });

    it('truncates long descriptions', () => {
        const skill: WelcomeSkill = {
            name: 'impeccable',
            description: 'A'.repeat(200),
            scopeId: 'project-mctrl',
        };
        const result = formatSkillRow(skill);
        expect(result.value.length).toBe(48);
        expect(result.value.endsWith('\u2026')).toBe(true);
    });

    it('clamps long descriptions to an explicit narrow value budget', () => {
        const skill: WelcomeSkill = {
            name: 'impeccable',
            description: 'A'.repeat(200),
            scopeId: 'project-mctrl',
        };
        const result = formatSkillRow(skill, 36);

        expect(terminalDisplayWidth(result.value)).toBe(36);
        expect(result.value.endsWith('\u2026')).toBe(true);
    });

    it('handles missing description', () => {
        const skill: WelcomeSkill = { name: 'nope', scopeId: 'project-agents' };
        const result = formatSkillRow(skill);
        expect(result.value).toBe('');
    });
});

describe('welcomeWidthBudget', () => {
    it('keeps 60-column welcome rows within the content width after horizontal padding', () => {
        const budget = welcomeWidthBudget(60);
        const skill: WelcomeSkill = {
            name: 'impeccable',
            description: 'A'.repeat(200),
            scopeId: 'project-mctrl',
        };
        const row = formatSkillRow(skill, budget.skillValueWidth);
        const rowWidth =
            terminalDisplayWidth(padToWidth(row.label, budget.labelWidth)) + terminalDisplayWidth(row.value);
        const headerWidth =
            terminalDisplayWidth('PROJECT SKILLS') +
            terminalDisplayWidth(sectionDividerRule('PROJECT SKILLS', budget.contentWidth));
        const hintWidth = terminalDisplayWidth(formatWelcomeHint(budget.contentWidth));

        expect(budget).toEqual({ contentWidth: 56, labelWidth: 20, valueWidth: 36, skillValueWidth: 36 });
        expect(rowWidth).toBeLessThanOrEqual(budget.contentWidth);
        expect(headerWidth).toBeLessThanOrEqual(budget.contentWidth);
        expect(hintWidth).toBeLessThanOrEqual(budget.contentWidth);
    });

    it('preserves the original section divider width when the terminal is wide enough', () => {
        const headerWidth =
            terminalDisplayWidth('PROJECT SKILLS') + terminalDisplayWidth(sectionDividerRule('PROJECT SKILLS', 76));

        expect(headerWidth).toBe(61);
    });
});

describe('welcomeRowBudgetPlan', () => {
    it('bounds the 60x15 welcome screen to the dock-derived upper row budget', () => {
        // Given: a short terminal whose bottom dock policy leaves nine rows for the upper region.
        const data = makeData({
            mcpServers: [
                { name: 'context7', type: 'remote', scope: 'user' },
                { name: 'filesystem', type: 'stdio', scope: 'project' },
            ],
            projectSkills: [
                { name: 'frontend', description: 'UI work', scopeId: 'project-mctrl' },
                { name: 'debugging', description: 'Runtime bug work', scopeId: 'project-agents' },
            ],
            lspServers: [
                { languageId: 'typescript', command: 'typescript-language-server', available: true },
                { languageId: 'rust', command: 'rust-analyzer', available: false },
                { languageId: 'go', command: 'gopls', available: true },
            ],
            recentSessions: [
                { sessionId: 'ses_one', messageCount: 4 },
                { sessionId: 'ses_two', messageCount: 8 },
            ],
        });

        // When: the welcome layout is planned for the 60x15 upper row budget.
        const plan = welcomeRowBudgetPlan({
            data,
            availableRows: 9,
            projectDescriptor: 'mission-control:main',
        });

        // Then: the compact plan fits, preserves header/environment/status context, and omits lower optional rows.
        expect(plan.mode).toBe('compact');
        expect(plan.visibleRows).toBeLessThanOrEqual(9);
        expect(plan.compactRowKeys).toEqual([
            'title',
            'version',
            'environmentHeader',
            'defaultModel',
            'project',
            'mcpSummary',
            'skillsSummary',
            'lspSummary',
            'hint',
        ]);
        expect(plan.omittedSections).toEqual(['recentSessions']);
    });

    it('keeps the full welcome layout when no row budget is supplied', () => {
        const plan = welcomeRowBudgetPlan({ data: makeData() });

        expect(plan.mode).toBe('full');
        expect(plan.compactRowKeys).toEqual([]);
        expect(plan.omittedSections).toEqual([]);
    });
});

describe('WelcomeScreen row budget', () => {
    it('plans no more compact child rows than the 60x15 upper region allows', () => {
        const data = makeData({
            recentSessions: [
                { sessionId: 'ses_one', messageCount: 4 },
                { sessionId: 'ses_two', messageCount: 8 },
            ],
        });

        const projectDescriptor = buildProjectDescriptor('mission-control', 'main', undefined);
        const plan = welcomeRowBudgetPlan({
            data,
            availableRows: 9,
            ...(projectDescriptor !== undefined ? { projectDescriptor } : {}),
        });

        expect(plan.visibleRows).toBeLessThanOrEqual(9);
    });
});

describe('formatLspGlyphs', () => {
    it('renders ✓ for available and ✗ for missing', () => {
        const servers: readonly WelcomeLspServer[] = [
            { languageId: 'typescript', command: 'typescript-language-server', available: true },
            { languageId: 'go', command: 'gopls', available: false },
        ];
        const glyphs = formatLspGlyphs(servers);
        expect(glyphs).toEqual([
            { text: '\u2713 typescript', available: true },
            { text: '\u2717 go', available: false },
        ]);
    });

    it('returns an empty list for no servers', () => {
        expect(formatLspGlyphs([])).toEqual([]);
    });
});

describe('formatSessionRow', () => {
    it('joins id, time, and message count', () => {
        const session: WelcomeSession = {
            sessionId: 'ses_abc',
            updatedAt: isoMinutesAgo(60 * 5),
            messageCount: 12,
        };
        expect(formatSessionRow(session, NOW)).toEqual({
            label: 'ses_abc',
            time: '5h ago',
            count: '12 messages',
        });
    });

    it('uses singular "message" when count is 1', () => {
        const session: WelcomeSession = { sessionId: 'ses_one', messageCount: 1 };
        expect(formatSessionRow(session, NOW).count).toBe('1 message');
    });

    it('omits time when updatedAt is missing', () => {
        const session: WelcomeSession = { sessionId: 'ses_one', messageCount: 1 };
        expect(formatSessionRow(session, NOW).time).toBeUndefined();
    });
});

describe('buildProjectDescriptor', () => {
    it('appends branch and worktree marker', () => {
        expect(buildProjectDescriptor('mission-control', 'main', true)).toBe('mission-control:main (worktree)');
    });
});
