import wrapAnsi from 'wrap-ansi';
import { terminalDisplayWidth } from '../terminal-text.js';
import type { InlineRun, RenderLine } from './ir-types.js';

export function longestWordWidth(text: string, max?: number): number {
    let longest = 0;
    for (const word of text.split(/\s+/u)) longest = Math.max(longest, terminalDisplayWidth(word));
    return max === undefined ? longest : Math.min(longest, max);
}

export function computeTableColumnWidths(
    headerCells: readonly string[],
    rows: readonly (readonly string[])[],
    availableWidth: number,
): readonly number[] | null {
    const count = headerCells.length;
    const availableCells = availableWidth - (3 * count + 1);
    if (count === 0 || availableCells < count) return null;
    const natural = new Array<number>(count).fill(0);
    const minimum = new Array<number>(count).fill(1);
    const scan = (text: string, column: number): void => {
        if (column >= count) return;
        natural[column] = Math.max(natural[column] ?? 0, terminalDisplayWidth(text));
        minimum[column] = Math.max(minimum[column] ?? 1, longestWordWidth(text, 30));
    };
    headerCells.forEach(scan);
    for (const row of rows) row.forEach(scan);
    let constrained = minimum.slice();
    let constrainedTotal = constrained.reduce((sum, width) => sum + width, 0);
    if (constrainedTotal > availableCells) {
        constrained = new Array<number>(count).fill(1);
        const remainder = availableCells - count;
        const weightTotal = minimum.reduce((sum, width) => sum + Math.max(0, width - 1), 0);
        const growth = minimum.map((width) =>
            weightTotal > 0 ? Math.floor((Math.max(0, width - 1) / weightTotal) * Math.max(0, remainder)) : 0,
        );
        constrained = constrained.map((width, index) => width + (growth[index] ?? 0));
        let leftover = Math.max(0, remainder) - growth.reduce((sum, width) => sum + width, 0);
        for (let index = 0; leftover > 0 && index < count; index += 1, leftover -= 1) {
            constrained[index] = (constrained[index] ?? 0) + 1;
        }
        constrainedTotal = constrained.reduce((sum, width) => sum + width, 0);
    }
    if (natural.reduce((sum, width) => sum + width, 0) + (3 * count + 1) <= availableWidth) {
        return natural.map((width, index) => Math.max(width, constrained[index] ?? 1));
    }
    const availableGrowth = Math.max(0, availableCells - constrainedTotal);
    const potential = natural.reduce((sum, width, index) => sum + Math.max(0, width - (constrained[index] ?? 1)), 0);
    const widths = constrained.map((minimumWidth, index) => {
        const delta = Math.max(0, (natural[index] ?? 0) - minimumWidth);
        return minimumWidth + (potential > 0 ? Math.floor((delta / potential) * availableGrowth) : 0);
    });
    let remaining = availableCells - widths.reduce((sum, width) => sum + width, 0);
    while (remaining > 0) {
        let grew = false;
        for (let index = 0; index < count && remaining > 0; index += 1) {
            if ((widths[index] ?? 0) < (natural[index] ?? 0)) {
                widths[index] = (widths[index] ?? 0) + 1;
                remaining -= 1;
                grew = true;
            }
        }
        if (!grew) break;
    }
    return widths;
}

export function buildTableBorder(kind: 'top' | 'mid' | 'bot', widths: readonly number[]): string {
    const join = kind === 'top' ? '─┬─' : kind === 'mid' ? '─┼─' : '─┴─';
    const opening = kind === 'top' ? '┌─' : kind === 'mid' ? '├─' : '└─';
    const closing = kind === 'top' ? '─┐' : kind === 'mid' ? '─┤' : '─┘';
    return `${opening}${widths.map((width) => '─'.repeat(width)).join(join)}${closing}`;
}

export function reflowRuns(runs: readonly InlineRun[], width: number): readonly RenderLine[] {
    const segments: InlineRun[][] = [[]];
    for (const run of runs) {
        for (const [index, part] of run.text.split('\n').entries()) {
            if (index > 0) segments.push([]);
            if (part.length > 0) {
                const current = segments.at(-1);
                if (current !== undefined)
                    current.push({ text: part, style: run.style, ...(run.href ? { href: run.href } : {}) });
            }
        }
    }
    const lines: RenderLine[] = [];
    for (const segment of segments) lines.push(...wrapSegment(segment, Math.max(1, width)));
    return lines.length === 0 ? [[]] : lines;
}

function wrapSegment(segment: readonly InlineRun[], width: number): readonly RenderLine[] {
    if (segment.length === 0) return [[]];
    const wrapped = wrapAnsi(segment.map((run) => run.text).join(''), width, { hard: true, trim: false }).split('\n');
    let runIndex = 0;
    let runOffset = 0;
    return wrapped.map((line) => {
        let remaining = line.length;
        const lineRuns: InlineRun[] = [];
        while (remaining > 0 && runIndex < segment.length) {
            const run = segment[runIndex];
            if (run === undefined) break;
            const size = Math.min(remaining, run.text.length - runOffset);
            lineRuns.push({
                text: run.text.slice(runOffset, runOffset + size),
                style: run.style,
                ...(run.href ? { href: run.href } : {}),
            });
            remaining -= size;
            runOffset += size;
            if (runOffset >= run.text.length) {
                runIndex += 1;
                runOffset = 0;
            }
        }
        return lineRuns;
    });
}
