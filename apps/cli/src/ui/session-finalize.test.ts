import { describe, expect, it, vi } from 'vitest';
import { JsonRenderer, PlainRenderer } from './renderers';
import {
    formatSessionFinalizeLine,
    formatSessionFinalizeLineFromInfo,
    type SessionFinalizeInfo,
} from './session-finalize';

describe('formatSessionFinalizeLine', () => {
    it('produces a bare status line when no reason is supplied', () => {
        expect(formatSessionFinalizeLine('complete')).toBe('Session complete');
        expect(formatSessionFinalizeLine('aborted')).toBe('Session aborted');
        expect(formatSessionFinalizeLine('failed')).toBe('Session failed');
    });

    it('treats an empty-string reason as no reason', () => {
        expect(formatSessionFinalizeLine('failed', '')).toBe('Session failed');
        expect(formatSessionFinalizeLine('aborted', '')).toBe('Session aborted');
    });

    it('appends the reason with a colon separator', () => {
        expect(formatSessionFinalizeLine('failed', 'provider rate limit exceeded')).toBe(
            'Session failed: provider rate limit exceeded',
        );
        expect(formatSessionFinalizeLine('aborted', 'interrupted by user')).toBe(
            'Session aborted: interrupted by user',
        );
    });

    it('formatSessionFinalizeLineFromInfo matches the direct call', () => {
        const info: SessionFinalizeInfo = { status: 'failed', reason: 'sidecar handshake failed' };
        expect(formatSessionFinalizeLineFromInfo(info)).toBe('Session failed: sidecar handshake failed');
        expect(formatSessionFinalizeLineFromInfo({ status: 'complete' })).toBe('Session complete');
    });
});

describe('PlainRenderer finalize', () => {
    it('writes a plain text line to stdout and exposes it in getOutput', () => {
        const stdoutWrites: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
            stdoutWrites.push(typeof text === 'string' ? text : text.toString());
            return true;
        });
        try {
            const renderer = new PlainRenderer();
            renderer.finalize({ status: 'complete' });
            expect(stdoutWrites.join('')).toContain('Session complete\n');
            expect(renderer.getOutput()).toContain('Session complete');
        } finally {
            spy.mockRestore();
        }
    });

    it('is idempotent: a second finalize call does not duplicate output', () => {
        const stdoutWrites: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
            stdoutWrites.push(typeof text === 'string' ? text : text.toString());
            return true;
        });
        try {
            const renderer = new PlainRenderer();
            renderer.finalize({ status: 'aborted', reason: 'interrupted by user' });
            renderer.finalize({ status: 'complete' });
            const all = stdoutWrites.join('');
            expect(all.match(/Session aborted/g)?.length ?? 0).toBe(1);
            expect(all).not.toContain('Session complete');
            expect(renderer.getOutput()).toContain('Session aborted: interrupted by user');
            expect(renderer.getOutput()).not.toContain('Session complete');
        } finally {
            spy.mockRestore();
        }
    });
});

describe('JsonRenderer finalize', () => {
    it('does not write a plain-text line; the durable session.finalize event flows through render() instead', () => {
        const stdoutWrites: string[] = [];
        const stderrWrites: string[] = [];
        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
            stdoutWrites.push(typeof text === 'string' ? text : text.toString());
            return true;
        });
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
            stderrWrites.push(typeof text === 'string' ? text : text.toString());
            return true;
        });
        try {
            const renderer = new JsonRenderer();
            renderer.finalize({ status: 'failed', reason: 'provider error' });
            expect(stdoutWrites.join('')).toBe('');
            expect(stderrWrites.join('')).toBe('');
            expect(renderer.getOutput().trim()).toBe('');
        } finally {
            stdoutSpy.mockRestore();
            stderrSpy.mockRestore();
        }
    });

    it('renders a session.finalize JSON event line when one is pushed through render()', () => {
        const renderer = new JsonRenderer();
        renderer.render({
            type: 'session.finalize',
            timestamp: '2026-07-21T00:00:00.000Z',
            message: 'Session failed: provider error',
            sessionFinalize: { status: 'failed', reason: 'provider error' },
        });
        const output = renderer.getOutput().trim();
        expect(output).toContain('"type":"session.finalize"');
        expect(output).toContain('"status":"failed"');
        expect(output).toContain('"reason":"provider error"');
    });
});
