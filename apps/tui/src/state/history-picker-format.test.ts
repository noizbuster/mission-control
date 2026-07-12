import { describe, expect, it } from 'vitest';
import {
    formatHistoryAbsoluteTime,
    formatHistoryContentPreview,
    formatHistoryRelativeTime,
    formatHistoryTimeColumn,
} from './history-picker-format.js';

const EM_DASH = '—';
const ELLIPSIS = '…';

describe('formatHistoryContentPreview', () => {
    it('returns a single empty line for empty text', () => {
        expect(formatHistoryContentPreview('')).toEqual(['']);
    });

    it('returns all lines when there are at most four', () => {
        expect(formatHistoryContentPreview('one')).toEqual(['one']);
        expect(formatHistoryContentPreview('a\nb\nc')).toEqual(['a', 'b', 'c']);
        expect(formatHistoryContentPreview('a\nb\nc\nd')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('keeps empty lines as lines', () => {
        expect(formatHistoryContentPreview('a\n\nb')).toEqual(['a', '', 'b']);
    });

    it('windows to first two, ellipsis, last two when more than four lines', () => {
        expect(formatHistoryContentPreview('l0\nl1\nl2\nl3\nl4')).toEqual(['l0', 'l1', ELLIPSIS, 'l3', 'l4']);
    });
});

describe('formatHistoryAbsoluteTime', () => {
    // Local noon on 2026-07-10 so same-day / older checks are stable.
    const nowMs = new Date(2026, 6, 10, 12, 0, 0, 0).getTime();

    it('returns em dash for legacy timestamp 0', () => {
        expect(formatHistoryAbsoluteTime(0, nowMs)).toBe(EM_DASH);
    });

    it('formats same local calendar day as HH:mm', () => {
        const sameDay = new Date(2026, 6, 10, 14, 30, 0, 0).getTime();
        expect(formatHistoryAbsoluteTime(sameDay, nowMs)).toBe('14:30');
    });

    it('zero-pads hours and minutes on the same day', () => {
        const early = new Date(2026, 6, 10, 9, 5, 0, 0).getTime();
        expect(formatHistoryAbsoluteTime(early, nowMs)).toBe('09:05');
    });

    it('formats older local days as fixed English MMM D HH:mm', () => {
        const older = new Date(2026, 6, 9, 14, 30, 0, 0).getTime();
        expect(formatHistoryAbsoluteTime(older, nowMs)).toBe('Jul 9 14:30');
    });
});

describe('formatHistoryRelativeTime', () => {
    const nowMs = new Date(2026, 6, 10, 12, 0, 0, 0).getTime();

    it('returns em dash for legacy timestamp 0', () => {
        expect(formatHistoryRelativeTime(0, nowMs)).toBe(EM_DASH);
    });

    it('returns just now for under 60 seconds', () => {
        expect(formatHistoryRelativeTime(nowMs - 500, nowMs)).toBe('just now');
    });

    it('returns Nm ago under 60 minutes', () => {
        expect(formatHistoryRelativeTime(nowMs - 5 * 60_000, nowMs)).toBe('5m ago');
    });

    it('returns Nh ago under 24 hours', () => {
        expect(formatHistoryRelativeTime(nowMs - 3 * 60 * 60_000, nowMs)).toBe('3h ago');
    });

    it('returns yesterday under 48 hours', () => {
        expect(formatHistoryRelativeTime(nowMs - 26 * 60 * 60_000, nowMs)).toBe('yesterday');
    });

    it('returns Nd ago under 7 days', () => {
        expect(formatHistoryRelativeTime(nowMs - 3 * 24 * 60 * 60_000, nowMs)).toBe('3d ago');
    });

    it('returns local YYYY-MM-DD for older than a week', () => {
        const older = new Date(2026, 5, 20, 8, 0, 0, 0).getTime();
        expect(formatHistoryRelativeTime(older, nowMs)).toBe('2026-06-20');
    });

    it('clamps future timestamps like WelcomeScreen (Math.max 0 delta)', () => {
        expect(formatHistoryRelativeTime(nowMs + 60_000, nowMs)).toBe('just now');
    });
});

describe('formatHistoryTimeColumn', () => {
    const nowMs = new Date(2026, 6, 10, 12, 0, 0, 0).getTime();

    it('combines absolute and relative as "absolute (relative)"', () => {
        const fiveMinAgo = new Date(2026, 6, 10, 11, 55, 0, 0).getTime();
        expect(formatHistoryTimeColumn(fiveMinAgo, nowMs)).toBe('11:55 (5m ago)');
    });

    it('returns em dash pair for legacy timestamp 0', () => {
        expect(formatHistoryTimeColumn(0, nowMs)).toBe(`${EM_DASH} (${EM_DASH})`);
    });
});
