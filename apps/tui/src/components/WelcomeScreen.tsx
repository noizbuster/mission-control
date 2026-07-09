import { padEndToDisplayWidth, terminalDisplayWidth, truncateTerminalText } from '@mission-control/tui';
import { TextAttributes } from '@opentui/core';
import { For, type JSX, Show } from 'solid-js';
import type {
    WelcomeData,
    WelcomeLspServer,
    WelcomeMcpServer,
    WelcomeSession,
    WelcomeSkill,
} from '../state/welcome-data-types.js';

export type WelcomeScreenProps = {
    readonly data: WelcomeData;
    readonly viewportColumns?: number;
    readonly availableRows?: number;
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

const DEFAULT_VIEWPORT_COLUMNS = 80;
const HORIZONTAL_PADDING_COLUMNS = 4;
const SECTION_HEADER_MAX_WIDTH = 61;
const WELCOME_HINT = 'Type a message to begin, / for commands, Ctrl+C twice to exit.';

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
    if (width <= 0) return '';
    if (terminalDisplayWidth(text) <= width) return text;
    if (width <= 1) return truncateTerminalText(text, width, '');
    return truncateTerminalText(text, width, '\u2026');
}

export type WelcomeWidthBudget = {
    readonly contentWidth: number;
    readonly labelWidth: number;
    readonly valueWidth: number;
    readonly skillValueWidth: number;
};

export type WelcomeCompactRowKey =
    | 'title'
    | 'version'
    | 'environmentHeader'
    | 'defaultModel'
    | 'project'
    | 'mcpSummary'
    | 'skillsSummary'
    | 'lspSummary'
    | 'recentSummary'
    | 'hint';

export type WelcomeOptionalSection = 'mcpServers' | 'projectSkills' | 'lspServers' | 'recentSessions';

export type WelcomeRowBudgetPlan = {
    readonly mode: 'full' | 'compact';
    readonly visibleRows: number;
    readonly compactRowKeys: readonly WelcomeCompactRowKey[];
    readonly omittedSections: readonly WelcomeOptionalSection[];
};

type WelcomeRowBudgetPlanInput = {
    readonly data: WelcomeData;
    readonly availableRows?: number;
    readonly projectDescriptor?: string;
};

type CompactWelcomeRowContext = {
    readonly data: WelcomeData;
    readonly widthBudget: WelcomeWidthBudget;
    readonly modelLine: { readonly label: string; readonly value: string };
    readonly projectDescriptor?: string;
};

export function welcomeWidthBudget(viewportColumns: number = DEFAULT_VIEWPORT_COLUMNS): WelcomeWidthBudget {
    const contentWidth = Math.max(1, viewportColumns - HORIZONTAL_PADDING_COLUMNS);
    const labelWidth = Math.min(LABEL_WIDTH, contentWidth);
    const valueWidth = Math.max(0, contentWidth - labelWidth);
    return {
        contentWidth,
        labelWidth,
        valueWidth,
        skillValueWidth: Math.min(SKILL_DESC_MAX, valueWidth),
    };
}

export function welcomeRowBudgetPlan(input: WelcomeRowBudgetPlanInput): WelcomeRowBudgetPlan {
    const fullVisibleRows = welcomeFullVisibleRows(input.data, input.projectDescriptor);
    if (input.availableRows === undefined) {
        return { mode: 'full', visibleRows: fullVisibleRows, compactRowKeys: [], omittedSections: [] };
    }
    const availableRows = clampAvailableRows(input.availableRows);
    if (availableRows >= fullVisibleRows) {
        return { mode: 'full', visibleRows: fullVisibleRows, compactRowKeys: [], omittedSections: [] };
    }

    const compactRowKeys = welcomeCompactRowKeys(availableRows, input.projectDescriptor !== undefined);
    return {
        mode: 'compact',
        visibleRows: compactRowKeys.length,
        compactRowKeys,
        omittedSections: omittedCompactSections(compactRowKeys, input.data),
    };
}

function welcomeFullVisibleRows(data: WelcomeData, projectDescriptor: string | undefined): number {
    return (
        1 +
        4 +
        2 +
        1 +
        (projectDescriptor !== undefined ? 1 : 0) +
        2 +
        listRows(data.mcpServers.length) +
        2 +
        listRows(data.projectSkills.length) +
        2 +
        1 +
        2 +
        listRows(data.recentSessions.length) +
        2
    );
}

function listRows(count: number): number {
    return Math.max(1, count);
}

function clampAvailableRows(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.floor(value);
}

function welcomeCompactRowKeys(availableRows: number, hasProject: boolean): readonly WelcomeCompactRowKey[] {
    const topRows: readonly WelcomeCompactRowKey[] = ['title', 'version', 'environmentHeader', 'defaultModel'];
    const optionalRows: WelcomeCompactRowKey[] = [];
    if (hasProject) optionalRows.push('project');
    optionalRows.push('mcpSummary', 'skillsSummary', 'lspSummary', 'recentSummary');

    if (availableRows <= 0) return [];
    if (availableRows < topRows.length + 1) {
        return [...topRows.slice(0, Math.max(0, availableRows - 1)), 'hint'];
    }

    const optionalCapacity = availableRows - topRows.length - 1;
    return [...topRows, ...optionalRows.slice(0, optionalCapacity), 'hint'];
}

function omittedCompactSections(
    compactRowKeys: readonly WelcomeCompactRowKey[],
    data: WelcomeData,
): readonly WelcomeOptionalSection[] {
    const rows = new Set(compactRowKeys);
    const omitted: WelcomeOptionalSection[] = [];
    if (!rows.has('mcpSummary') && data.mcpServers.length > 0) omitted.push('mcpServers');
    if (!rows.has('skillsSummary') && data.projectSkills.length > 0) omitted.push('projectSkills');
    if (!rows.has('lspSummary') && data.lspServers.length > 0) omitted.push('lspServers');
    if (!rows.has('recentSummary') && data.recentSessions.length > 0) omitted.push('recentSessions');
    return omitted;
}

export function sectionDividerRule(title: string, contentWidth: number = welcomeWidthBudget().contentWidth): string {
    const headerWidth = Math.min(SECTION_HEADER_MAX_WIDTH, contentWidth);
    const ruleWidth = Math.max(0, headerWidth - terminalDisplayWidth(title) - 1);
    return ruleWidth > 0 ? ` ${'\u2500'.repeat(ruleWidth)}` : '';
}

export function formatWelcomeHint(contentWidth: number = welcomeWidthBudget().contentWidth): string {
    return truncateToWidth(WELCOME_HINT, contentWidth);
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
export function formatSkillRow(
    skill: WelcomeSkill,
    maxDescriptionWidth: number = SKILL_DESC_MAX,
): { readonly label: string; readonly value: string } {
    const rawDesc = skill.description ?? '';
    return {
        label: skill.name,
        value: truncateToWidth(rawDesc, maxDescriptionWidth),
    };
}

/**
 * Collapse every LSP server onto a single row with availability glyphs.
 * Available servers render as `✓ lang`; missing ones as `✗ lang`. The two
 * are space-separated. Returns the rendered string plus the per-glyph colors
 * so the render layer can color each glyph independently.
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
export function WelcomeScreen(props: WelcomeScreenProps): JSX.Element {
    const widthBudget = () => welcomeWidthBudget(props.viewportColumns);
    const modelLine = () => formatModelLine(props.data);
    const projectDescriptor = () =>
        buildProjectDescriptor(props.projectLabel, props.gitBranch, props.isWorktree);
    const lspGlyphs = () => formatLspGlyphs(props.data.lspServers);
    const rowPlan = () => {
        const descriptor = projectDescriptor();
        return welcomeRowBudgetPlan({
            data: props.data,
            ...(props.availableRows !== undefined ? { availableRows: props.availableRows } : {}),
            ...(descriptor !== undefined ? { projectDescriptor: descriptor } : {}),
        });
    };
    const compactContext = (): CompactWelcomeRowContext => {
        const descriptor = projectDescriptor();
        return {
            data: props.data,
            widthBudget: widthBudget(),
            modelLine: { label: modelLine().label, value: modelLine().value },
            ...(descriptor !== undefined ? { projectDescriptor: descriptor } : {}),
        };
    };

    return (
        <Show
            when={rowPlan().mode === 'compact'}
            fallback={
                <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
                    <WelcomeHeader version={props.data.version} />
                    <SectionHeader title="ENVIRONMENT" contentWidth={widthBudget().contentWidth} />
                    <TwoColumnRow
                        label={modelLine().label}
                        value={modelLine().value}
                        widthBudget={widthBudget()}
                    />
                    {projectDescriptor() !== undefined ? (
                        <TwoColumnRow
                            label="project"
                            value={projectDescriptor() ?? ''}
                            widthBudget={widthBudget()}
                        />
                    ) : null}

                    <SectionHeader title="MCP SERVERS" contentWidth={widthBudget().contentWidth} />
                    {props.data.mcpServers.length === 0 ? (
                        <EmptyHint text="no servers configured" widthBudget={widthBudget()} />
                    ) : (
                        <For each={props.data.mcpServers}>
                            {(server) => {
                                const row = formatMcpServerRow(server);
                                return (
                                    <TwoColumnRow
                                        label={row.label}
                                        value={row.value}
                                        widthBudget={widthBudget()}
                                    />
                                );
                            }}
                        </For>
                    )}

                    <SectionHeader title="PROJECT SKILLS" contentWidth={widthBudget().contentWidth} />
                    {props.data.projectSkills.length === 0 ? (
                        <EmptyHint
                            text="no project-scoped skills (.mctrl/skills, .agents/skills)"
                            widthBudget={widthBudget()}
                        />
                    ) : (
                        <For each={props.data.projectSkills}>
                            {(skill) => {
                                const row = formatSkillRow(skill, widthBudget().skillValueWidth);
                                return (
                                    <TwoColumnRow
                                        label={row.label}
                                        value={row.value}
                                        widthBudget={widthBudget()}
                                    />
                                );
                            }}
                        </For>
                    )}

                    <SectionHeader title="LSP SERVERS" contentWidth={widthBudget().contentWidth} />
                    {lspGlyphs().length === 0 ? (
                        <EmptyHint text="no servers in catalog" widthBudget={widthBudget()} />
                    ) : (
                        <LspGlyphRow glyphs={lspGlyphs()} />
                    )}

                    <SectionHeader title="RECENT SESSIONS" contentWidth={widthBudget().contentWidth} />
                    {props.data.recentSessions.length === 0 ? (
                        <EmptyHint text="no sessions yet for this project" widthBudget={widthBudget()} />
                    ) : (
                        <For each={props.data.recentSessions}>
                            {(session) => <SessionRow session={session} widthBudget={widthBudget()} />}
                        </For>
                    )}

                    <box marginTop={1}>
                        <text attributes={TextAttributes.DIM}>{formatWelcomeHint(widthBudget().contentWidth)}</text>
                    </box>
                </box>
            }
        >
            <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2}>
                <For each={rowPlan().compactRowKeys}>
                    {(rowKey) => renderCompactWelcomeRow(rowKey, compactContext())}
                </For>
            </box>
        </Show>
    );
}

function renderCompactWelcomeRow(rowKey: WelcomeCompactRowKey, context: CompactWelcomeRowContext): JSX.Element | null {
    switch (rowKey) {
        case 'title':
            return (
                <text fg={HEADER_FG} attributes={TextAttributes.BOLD}>
                    {'mission-control'}
                </text>
            );
        case 'version':
            return <text attributes={TextAttributes.DIM}>{`v${context.data.version}`}</text>;
        case 'environmentHeader':
            return (
                <text fg={HEADER_FG} attributes={TextAttributes.BOLD}>
                    {'ENVIRONMENT'}
                </text>
            );
        case 'defaultModel':
            return (
                <TwoColumnRow
                    label={context.modelLine.label}
                    value={context.modelLine.value}
                    widthBudget={context.widthBudget}
                />
            );
        case 'project':
            return context.projectDescriptor !== undefined ? (
                <TwoColumnRow label="project" value={context.projectDescriptor} widthBudget={context.widthBudget} />
            ) : null;
        case 'mcpSummary':
            return (
                <TwoColumnRow
                    label="mcp servers"
                    value={formatConfiguredSummary(context.data.mcpServers.length)}
                    widthBudget={context.widthBudget}
                />
            );
        case 'skillsSummary':
            return (
                <TwoColumnRow
                    label="project skills"
                    value={formatAvailableSummary(context.data.projectSkills.length)}
                    widthBudget={context.widthBudget}
                />
            );
        case 'lspSummary':
            return (
                <TwoColumnRow
                    label="lsp servers"
                    value={formatLspSummary(context.data.lspServers)}
                    widthBudget={context.widthBudget}
                />
            );
        case 'recentSummary':
            return (
                <TwoColumnRow
                    label="recent sessions"
                    value={formatRecentSummary(context.data.recentSessions.length)}
                    widthBudget={context.widthBudget}
                />
            );
        case 'hint':
            return <text attributes={TextAttributes.DIM}>{formatWelcomeHint(context.widthBudget.contentWidth)}</text>;
    }
}

function formatConfiguredSummary(count: number): string {
    return count === 0 ? 'none configured' : `${count} configured`;
}

function formatAvailableSummary(count: number): string {
    return count === 0 ? 'none available' : `${count} available`;
}

function formatLspSummary(servers: readonly WelcomeLspServer[]): string {
    if (servers.length === 0) return 'none in catalog';
    const available = servers.filter((server) => server.available).length;
    return `${available}/${servers.length} available`;
}

function formatRecentSummary(count: number): string {
    return count === 0 ? 'none yet' : `${count} recent`;
}

function WelcomeHeader({ version }: { readonly version: string }): JSX.Element {
    return (
        <box flexDirection="column" marginTop={1} marginBottom={1}>
            <text fg={HEADER_FG} attributes={TextAttributes.BOLD}>
                {'mission-control'}
            </text>
            <text attributes={TextAttributes.DIM}>{`v${version}`}</text>
        </box>
    );
}

function SectionHeader({
    title,
    contentWidth,
}: {
    readonly title: string;
    readonly contentWidth: number;
}): JSX.Element {
    return (
        <box flexDirection="row" marginTop={1} marginBottom={0}>
            <text fg={HEADER_FG} attributes={TextAttributes.BOLD}>
                {title}
            </text>
            <text attributes={TextAttributes.DIM}>{sectionDividerRule(title, contentWidth)}</text>
        </box>
    );
}

function TwoColumnRow({
    label,
    value,
    widthBudget,
}: {
    readonly label: string;
    readonly value: string;
    readonly widthBudget: WelcomeWidthBudget;
}): JSX.Element {
    return (
        <box flexDirection="row">
            <text attributes={TextAttributes.DIM}>{padToWidth(label, widthBudget.labelWidth)}</text>
            {widthBudget.valueWidth > 0 ? <text>{truncateToWidth(value, widthBudget.valueWidth)}</text> : null}
        </box>
    );
}

function EmptyHint({
    text,
    widthBudget,
}: {
    readonly text: string;
    readonly widthBudget: WelcomeWidthBudget;
}): JSX.Element {
    return (
        <box flexDirection="row">
            <text attributes={TextAttributes.DIM}>{padToWidth('(none)', widthBudget.labelWidth)}</text>
            {widthBudget.valueWidth > 0 ? (
                <text attributes={TextAttributes.DIM}>{truncateToWidth(text, widthBudget.valueWidth)}</text>
            ) : null}
        </box>
    );
}

function LspGlyphRow({ glyphs }: { readonly glyphs: readonly LspGlyph[] }): JSX.Element {
    return (
        <box flexDirection="row">
            <For each={glyphs}>
                {(glyph, index) => (
                    <box flexDirection="row">
                        {index() > 0 ? <text>{'   '}</text> : null}
                        <text
                            fg={glyph.available ? '#26d926' : DIM_FG}
                            attributes={glyph.available ? TextAttributes.BOLD : TextAttributes.DIM}
                        >
                            {glyph.text}
                        </text>
                    </box>
                )}
            </For>
        </box>
    );
}

function SessionRow({
    session,
    widthBudget,
}: {
    readonly session: WelcomeSession;
    readonly widthBudget: WelcomeWidthBudget;
}): JSX.Element {
    const row = formatSessionRow(session);
    const timePrefix = row.time !== undefined ? `${row.time}   ` : undefined;
    const timePrefixWidth = timePrefix === undefined ? 0 : terminalDisplayWidth(timePrefix);
    const countWidth = Math.max(0, widthBudget.valueWidth - timePrefixWidth);
    return (
        <box flexDirection="row">
            <text attributes={TextAttributes.DIM}>{padToWidth(row.label, widthBudget.labelWidth)}</text>
            {timePrefix !== undefined && widthBudget.valueWidth > 0 ? (
                <text fg={DIM_FG}>{truncateToWidth(timePrefix, widthBudget.valueWidth)}</text>
            ) : null}
            {countWidth > 0 ? <text>{truncateToWidth(row.count, countWidth)}</text> : null}
        </box>
    );
}
