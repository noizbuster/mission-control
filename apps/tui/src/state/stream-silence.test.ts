import { describe, expect, it } from 'vitest';
import {
    formatAgentStatusWithSilence,
    STREAM_SILENCE_WARN_MS,
    streamSilenceStatus,
} from './stream-silence';

describe('streamSilenceStatus', () => {
    it('is quiet when not generating or activity is fresh', () => {
        expect(
            streamSilenceStatus({
                generating: false,
                lastActivityAt: 0,
                now: 60_000,
            }),
        ).toEqual({ silentSeconds: undefined, label: undefined });

        expect(
            streamSilenceStatus({
                generating: true,
                lastActivityAt: 50_000,
                now: 50_000 + STREAM_SILENCE_WARN_MS - 1,
            }),
        ).toEqual({ silentSeconds: undefined, label: undefined });
    });

    it('warns after the silence window while generating', () => {
        expect(
            streamSilenceStatus({
                generating: true,
                lastActivityAt: 10_000,
                now: 10_000 + STREAM_SILENCE_WARN_MS,
            }),
        ).toEqual({ silentSeconds: 30, label: 'No events for 30s' });

        expect(
            streamSilenceStatus({
                generating: true,
                lastActivityAt: 0,
                now: 45_100,
            }).label,
        ).toBe('No events for 46s');
    });
});

describe('formatAgentStatusWithSilence', () => {
    it('merges base status with the silence suffix', () => {
        expect(formatAgentStatusWithSilence('Working…', undefined)).toBe('Working…');
        expect(formatAgentStatusWithSilence('', 'No events for 30s')).toBe(
            'No events for 30s — still waiting…',
        );
        expect(formatAgentStatusWithSilence('Thinking', 'No events for 30s')).toBe(
            'Thinking · No events for 30s',
        );
    });
});
