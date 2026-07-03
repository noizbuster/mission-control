/** @jsxImportSource @opentui/react */
import { TextAttributes } from '@opentui/core';
import type * as React from 'react';
import type { WelcomeData, WelcomeLspServer, WelcomeMcpServer, WelcomeSession, WelcomeSkill } from '../commands/welcome-data.js';
import { padEndToDisplayWidth, terminalDisplayWidth, truncateTerminalText } from '../commands/terminal-text.js';

export type WelcomeScreenProps = {
    readonly data: WelcomeData;
    /** Workspace root basename + git branch, used in the environment section. */
    readonly projectLabel?: string;
    readonly gitBranch?: string;
    readonly isWorktree?: boolean;
};

/** Column width reserved for the left label in two-column rows. */
const LABEL_WIDTH = 20;

/** Maximum length for a session id before it is truncated with an ellipsis. */
const SESSION_ID_MAX = 16;

/** Maximum length for a skill description before it is truncated. */
const SKILL_DESC_MAX = 48;

/** Title bar foreground (matches the existing overlay accent default). */
const HEADER_FG = '#00ffff';

/** Muted color for section dividers and metadata. */
const DIM_FG = '#888888';

/**
 * Pad or truncate a string to exactly `width` columns. Strings shorter than
 * the target are right-padded with spaces; longer strings are truncated with
 * an ellipsis at `width - 1` columns.
 */
export function padToWidth(text: string, width: number): string {
    const textWidth = terminalDisplayWidth(text);
    if (textWidth === width) return text;
    if (textWidth > width) {
        if (width <= 1) return truncateTerminalText(text, width, '');
        return truncateTerminalText(text, width, '\u2026');
    }
    return padEndToDisplayWidth(text, width);
}

export function truncateToWidth(text: string, width: number): string {
    if (terminalDisplayWidth(text) <= width) return text;
    if (width <= 1) return truncateTerminalText(text, width, '');
    return truncateTerminalText(text, width, '\u2026');
}

/** Truncate a session id to a fixed visible width with a trailing ellipsis. */
export function truncateSessionId(id: string, maxLen: number = SESSION_ID_MAX): string {
    return truncateToWidth(id, maxLen);
}

/**
 * Render an ISO timestamp as a short relative label. Returns `undefined` when
 * the input is missing or unparseable so the caller can omit the segment
 * entirely. Uses coarse buckets: <60s "just now", <60m "Nm ago", <24h "Nh ago",
 * <48h "yesterday", <7d "Nd ago", otherwise the ISO date.
 */
export function formatRelativeTime(isoTimestamp: string | undefined, now: Date = new Date()): string | undefined {
    if (isoTimestamp === undefined) return undefined;
    const then = Date.parse(isoTimestamp);
    if (Number.isNaN(then)) return undefined;
    const deltaMs = Math.max(0, now.getTime() - then);
    const sec = Math.floor(deltaMs / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    if (hr < 48) return 'yesterday';
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    // Fall back to the ISO calendar date for anything older than a week.
    return isoTimestamp.slice(0, 10);
}

/**
 * Build the environment-row left label "default model" + the right value
 * "provider / model". Pure for unit tests.
 */
export function formatModelLine(data: WelcomeData): { readonly label: string; readonly value: string } {
    return {
        label: 'default model',
        value: `${data.defaultModel.providerID} / ${data.defaultModel.modelID}`,
    };
}

/** Format an MCP server row: "name        type (scope)". */
export function formatMcpServerRow(server: WelcomeMcpServer): { readonly label: string; readonly value: string } {
    return {
        label: server.name,
        value: `${server.type} (${server.scope})`,
    };
}

/** Format a skill row; the description is truncated to keep one row per skill. */
export function formatSkillRow(skill: WelcomeSkill): { readonly label: string; readonly value: string } {
    const rawDesc = skill.description ?? '';
    return {
        label: skill.name,
        value: truncateToWidth(rawDesc, SKILL_DESC_MAX),
    };
}

/**
 * Collapse every LSP server onto a single row with availability glyphs.
 * Available servers render as `✓ lang`; missing ones as `✗ lang`. The two
 * are space-separated. Returns the rendered string plus the per-glyph colors
 * so the React layer can color each glyph independently.
 */
export type LspGlyph = { readonly text: string; readonly available: boolean };

export function formatLspGlyphs(servers: readonly WelcomeLspServer[]): readonly LspGlyph[] {
    return servers.map((server) => ({
        text: `${server.available ? '\u2713' : '\u2717'} ${server.languageId}`,
        available: server.available,
    }));
}

/** Format a session row: "sessionId   relative-time   N messages". */
export function formatSessionRow(
    session: WelcomeSession,
    now: Date = new Date(),
): { readonly label: string; readonly time: string | undefined; readonly count: string } {
    return {
        label: truncateSessionId(session.sessionId),
        time: formatRelativeTime(session.updatedAt, now),
        count: `${session.messageCount} ${session.messageCount === 1 ? 'message' : 'messages'}`,
    };
}

/** Build the project descriptor shown in the environment section. */
export function buildProjectDescriptor(
    projectLabel: string | undefined,
    gitBranch: string | undefined,
    isWorktree: boolean | undefined,
): string | undefined {
    if (projectLabel === undefined) return undefined;
    let label = projectLabel;
    if (gitBranch !== undefined && gitBranch.length > 0) {
        label = `${label}:${gitBranch}`;
    }
    if (isWorktree) {
        label = `${label} (worktree)`;
    }
    return label;
}

/**
 * The welcome screen rendered on the first frame of the chat TUI, before any
 * prompt has been submitted. It mirrors the project-meta panels used by hermes
 * and omp TUIs: version, environment, MCP servers, project skills, LSP
 * availability, and recent sessions.
 *
 * Purely presentational: it consumes a {@link WelcomeData} snapshot and emits
 * opentui primitives. Auto-hides once the user submits the first prompt (the
 * parent gates this on `snapshot.outputText === ''`).
 */
export function WelcomeScreen({ data, projectLabel, gitBranch, isWorktree }: WelcomeScreenProps): React.ReactNode {
    const { label: modelLabel, value: modelValue } = formatModelLine(data);
    const projectDescriptor = buildProjectDescriptor(projectLabel, gitBranch, isWorktree);
    const lspGlyphs = formatLspGlyphs(data.lspServers);

    return (
        <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
            <WelcomeHeader version={data.version} />
            <SectionHeader title="ENVIRONMENT" />
            <TwoColumnRow label={modelLabel} value={modelValue} />
            {projectDescriptor !== undefined ? <TwoColumnRow label="project" value={projectDescriptor} /> : null}

            <SectionHeader title="MCP SERVERS" />
            {data.mcpServers.length === 0 ? (
                <EmptyHint text="no servers configured" />
            ) : (
                data.mcpServers.map((server) => {
                    const row = formatMcpServerRow(server);
                    return <TwoColumnRow key={`mcp-${server.name}`} label={row.label} value={row.value} />;
                })
            )}

            <SectionHeader title="PROJECT SKILLS" />
            {data.projectSkills.length === 0 ? (
                <EmptyHint text="no project-scoped skills (.mctrl/skills, .agents/skills)" />
            ) : (
                data.projectSkills.map((skill) => {
                    const row = formatSkillRow(skill);
                    return <TwoColumnRow key={`skill-${skill.name}`} label={row.label} value={row.value} />;
                })
            )}

            <SectionHeader title="LSP SERVERS" />
            {lspGlyphs.length === 0 ? (
                <EmptyHint text="no servers in catalog" />
            ) : (
                <LspGlyphRow glyphs={lspGlyphs} />
            )}

            <SectionHeader title="RECENT SESSIONS" />
            {data.recentSessions.length === 0 ? (
                <EmptyHint text="no sessions yet for this project" />
            ) : (
                data.recentSessions.map((session) => (
                    <SessionRow key={`session-${session.sessionId}`} session={session} />
                ))
            )}

            <box marginTop={1}>
                <text attributes={TextAttributes.DIM}>
                    {'Type a message to begin, / for commands, Ctrl+C twice to exit.'}
                </text>
            </box>
        </box>
    );
}

function WelcomeHeader({ version }: { readonly version: string }): React.ReactNode {
    return (
        <box flexDirection="column" marginTop={1} marginBottom={1}>
            <text fg={HEADER_FG} attributes={TextAttributes.BOLD}>
                {'mission-control'}
            </text>
            <text attributes={TextAttributes.DIM}>{`v${version}`}</text>
        </box>
    );
}

function SectionHeader({ title }: { readonly title: string }): React.ReactNode {
    return (
        <box flexDirection="row" marginTop={1} marginBottom={0}>
            <text fg={HEADER_FG} attributes={TextAttributes.BOLD}>
                {title}
            </text>
            <text attributes={TextAttributes.DIM}>
                {` ${'\u2500'.repeat(Math.max(0, 60 - terminalDisplayWidth(title)))}`}
            </text>
        </box>
    );
}

function TwoColumnRow({ label, value }: { readonly label: string; readonly value: string }): React.ReactNode {
    return (
        <box flexDirection="row">
            <text attributes={TextAttributes.DIM}>{padToWidth(label, LABEL_WIDTH)}</text>
            <text>{value}</text>
        </box>
    );
}

function EmptyHint({ text }: { readonly text: string }): React.ReactNode {
    return (
        <box flexDirection="row">
            <text attributes={TextAttributes.DIM}>{padToWidth('(none)', LABEL_WIDTH)}</text>
            <text attributes={TextAttributes.DIM}>{text}</text>
        </box>
    );
}

function LspGlyphRow({ glyphs }: { readonly glyphs: readonly LspGlyph[] }): React.ReactNode {
    return (
        <box flexDirection="row">
            {glyphs.map((glyph, idx) => (
                <box key={`lsp-${glyph.text}`} flexDirection="row">
                    {idx > 0 ? <text>{'   '}</text> : null}
                    <text
                        fg={glyph.available ? '#26d926' : DIM_FG}
                        attributes={glyph.available ? TextAttributes.BOLD : TextAttributes.DIM}
                    >
                        {glyph.text}
                    </text>
                </box>
            ))}
        </box>
    );
}

function SessionRow({ session }: { readonly session: WelcomeSession }): React.ReactNode {
    const row = formatSessionRow(session);
    return (
        <box flexDirection="row">
            <text attributes={TextAttributes.DIM}>{padToWidth(row.label, LABEL_WIDTH)}</text>
            {row.time !== undefined ? <text fg={DIM_FG}>{`${row.time}   `}</text> : null}
            <text>{row.count}</text>
        </box>
    );
}
