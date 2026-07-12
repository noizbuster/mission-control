/**
 * Pure preview + time-column formatters for the prompt history picker.
 * Framework-free (no OpenTUI / solid-js).
 */

const EM_DASH = '—';
const ELLIPSIS = '…';

const ENGLISH_MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
] as const;

function pad2(value: number): string {
    return value < 10 ? `0${value}` : String(value);
}

function isSameLocalCalendarDay(aMs: number, bMs: number): boolean {
    const a = new Date(aMs);
    const b = new Date(bMs);
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatLocalYmd(timestampMs: number): string {
    const d = new Date(timestampMs);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatLocalHm(timestampMs: number): string {
    const d = new Date(timestampMs);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Split history entry text into preview lines for the picker content column.
 * More than 4 lines → first 2 + ellipsis + last 2.
 */
export function formatHistoryContentPreview(text: string): readonly string[] {
    const lines = text.split('\n');
    if (lines.length <= 4) {
        return lines;
    }
    const lastIndex = lines.length - 1;
    const secondLast = lines[lastIndex - 1];
    const last = lines[lastIndex];
    const first = lines[0];
    const second = lines[1];
    if (first === undefined || second === undefined || secondLast === undefined || last === undefined) {
        return lines;
    }
    return [first, second, ELLIPSIS, secondLast, last];
}

/**
 * Absolute local time for the history time column.
 * Legacy `timestampMs === 0` → em dash. Same local day → `HH:mm`. Older → `MMM D HH:mm`.
 */
export function formatHistoryAbsoluteTime(timestampMs: number, nowMs: number): string {
    if (timestampMs === 0) {
        return EM_DASH;
    }
    if (isSameLocalCalendarDay(timestampMs, nowMs)) {
        return formatLocalHm(timestampMs);
    }
    const d = new Date(timestampMs);
    const month = ENGLISH_MONTHS[d.getMonth()];
    if (month === undefined) {
        return formatLocalHm(timestampMs);
    }
    return `${month} ${d.getDate()} ${formatLocalHm(timestampMs)}`;
}

/**
 * Relative age buckets (ms epoch), matching WelcomeScreen semantics with local date fallback.
 */
export function formatHistoryRelativeTime(timestampMs: number, nowMs: number): string {
    if (timestampMs === 0) {
        return EM_DASH;
    }
    const deltaMs = Math.max(0, nowMs - timestampMs);
    const sec = Math.floor(deltaMs / 1000);
    if (sec < 60) {
        return 'just now';
    }
    const min = Math.floor(sec / 60);
    if (min < 60) {
        return `${min}m ago`;
    }
    const hr = Math.floor(min / 60);
    if (hr < 24) {
        return `${hr}h ago`;
    }
    if (hr < 48) {
        return 'yesterday';
    }
    const day = Math.floor(hr / 24);
    if (day < 7) {
        return `${day}d ago`;
    }
    return formatLocalYmd(timestampMs);
}

/** Combined time column: `absolute (relative)`, e.g. `14:30 (5m ago)`. */
export function formatHistoryTimeColumn(timestampMs: number, nowMs: number): string {
    const absolute = formatHistoryAbsoluteTime(timestampMs, nowMs);
    const relative = formatHistoryRelativeTime(timestampMs, nowMs);
    return `${absolute} (${relative})`;
}
