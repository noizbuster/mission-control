import { For, type JSX } from 'solid-js';
import { DiffView } from './diff/DiffView';
import { renderDiff } from './diff/render-diff';

export type ToolCardProps = {
    readonly lines: readonly string[];
    readonly title?: string;
    readonly expanded: boolean;
};

const FALLBACK_TITLE = 'Tool output';

/**
 * Detect whether the block contains unified-diff content. Returns true when any
 * line starts with a leading `+`, `-` (covers `+line`/`-line`/`+++ `/`--- `), or
 * `@@` hunk marker. Prose lines like `Target: foo` or `Edit preview for ...` do
 * not start with those markers and therefore return false.
 */
export function hasDiffContent(lines: readonly string[]): boolean {
    return lines.some((line) => line.startsWith('+') || line.startsWith('-') || line.startsWith('@@'));
}

/**
 * Build the header label text. When collapsed, a `(N lines)` hint is appended so
 * the user can gauge what is hidden. Exposed for unit testing.
 */
export function buildHeaderLabel(title: string | undefined, lineCount: number, expanded: boolean): string {
    const label = title ?? FALLBACK_TITLE;
    const suffix = expanded ? '' : ` (${lineCount} lines)`;
    return `> ${label}${suffix}`;
}

/**
 * Rich tool card: bordered box with a bold yellow header (tool title + optional
 * line-count hint when collapsed) and a body that routes diff content through
 * `<DiffView>` (green/red/inverse highlighting) and other content as plain
 * yellow lines. When collapsed, only the header renders.
 */
export function ToolCard({ lines, title, expanded }: ToolCardProps): JSX.Element {
    const header = buildHeaderLabel(title, lines.length, expanded);
    const yellow = '#ffff00';
    return (
        <box flexDirection="column">
            <text {...{ bold: true }} {...(yellow !== undefined ? { fg: yellow } : {})}>
                {header}
            </text>
            {expanded ? (
                hasDiffContent(lines) ? (
                    <DiffView lines={renderDiff(lines.join('\n'))} />
                ) : (
                    <For each={lines}>
                        {(line) => <text {...(yellow !== undefined ? { fg: yellow } : {})}>{line}</text>}
                    </For>
                )
            ) : null}
        </box>
    );
}
