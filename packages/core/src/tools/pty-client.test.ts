import type { SidecarStreamFrame } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { assemblePtyFrames, createPtySessionTransport, PTY_OUTPUT_CAP_BYTES } from './pty-client';

function frame(seq: number, payload: string, end: boolean, error?: string): SidecarStreamFrame {
    return {
        sessionId: 'pty-session',
        seq,
        payload,
        end,
        ...(error !== undefined ? { error } : {}),
    };
}

describe('pty-client assemblePtyFrames', () => {
    it('assembles a streaming pty allocation with monotonic seq and terminal end', () => {
        const frames: readonly SidecarStreamFrame[] = [
            frame(0, 'hel', false),
            frame(1, 'lo-', false),
            frame(2, 'pty\n', false),
            frame(3, '', true),
        ];

        const result = assemblePtyFrames(frames);

        expect(result.ended).toBe(true);
        expect(result.output).toBe('hello-pty\n');
        expect(result.truncated).toBe(false);
        expect(result.streamError).toBeNull();
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.originalBytes).toBe(Buffer.byteLength('hello-pty\n', 'utf8'));
    });

    it('truncates a flooding pty process at the cumulative cap and stops accepting', () => {
        const floodChunk = 'x'.repeat(4_000);
        const frames: SidecarStreamFrame[] = [];
        for (let seq = 0; seq < 40; seq += 1) {
            frames.push(frame(seq, floodChunk, false));
        }
        frames.push(frame(40, '', true, 'output_truncated'));

        const result = assemblePtyFrames(frames);

        expect(result.truncated).toBe(true);
        expect(result.returnedBytes).toBeLessThanOrEqual(PTY_OUTPUT_CAP_BYTES);
        expect(result.originalBytes).toBeGreaterThan(PTY_OUTPUT_CAP_BYTES);
        expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(PTY_OUTPUT_CAP_BYTES);
        expect(result.streamError).toBe('output_truncated');
    });

    it('honours a caller-supplied cap smaller than the default', () => {
        const frames: readonly SidecarStreamFrame[] = [frame(0, '0123456789', false), frame(1, 'abcdef', true)];

        const result = assemblePtyFrames(frames, { maxBytes: 8 });

        expect(result.truncated).toBe(true);
        expect(result.returnedBytes).toBe(8);
        expect(result.originalBytes).toBe(16);
        expect(result.output).toBe('01234567');
    });

    it('does not throw on an allocation-failure error frame and surfaces the stream error', () => {
        const frames: readonly SidecarStreamFrame[] = [frame(0, '', true, 'pty_alloc_failed: spawn rejected')];

        const result = assemblePtyFrames(frames);

        expect(result.ended).toBe(true);
        expect(result.output).toBe('');
        expect(result.streamError).toBe('pty_alloc_failed: spawn rejected');
        expect(result.exitCode).toBeNull();
    });

    it('derives nonzero exit code and timed-out state from the terminal frame marker', () => {
        const exitFrames: readonly SidecarStreamFrame[] = [
            frame(0, 'boom\n', false),
            frame(1, '', true, 'nonzero_exit:7'),
        ];
        const timedFrames: readonly SidecarStreamFrame[] = [
            frame(0, 'partial', false),
            frame(1, '', true, 'timed_out'),
        ];

        const exitResult = assemblePtyFrames(exitFrames);
        const timedResult = assemblePtyFrames(timedFrames);

        expect(exitResult.exitCode).toBe(7);
        expect(exitResult.timedOut).toBe(false);
        expect(timedResult.exitCode).toBeNull();
        expect(timedResult.timedOut).toBe(true);
    });

    it('redacts allowlisted secret values from the accepted payload', () => {
        const secret = 'pty-secret-value';
        const frames: readonly SidecarStreamFrame[] = [frame(0, `token=${secret}\n`, false), frame(1, '', true)];

        const result = assemblePtyFrames(frames, { redactionSecrets: [secret] });

        expect(result.output).not.toContain(secret);
    });

    it('rejects a stream whose seq is not strictly increasing', () => {
        const frames: readonly SidecarStreamFrame[] = [frame(0, 'a', false), frame(0, 'b', true)];

        expect(() => assemblePtyFrames(frames)).toThrow();
    });
});

describe('pty-client transport factory', () => {
    it('forwards the allocation request to the supplied stream-open sender', async () => {
        const received: PtyAllocRequestLike[] = [];
        const transport = createPtySessionTransport(async (request) => {
            received.push(request);
            return [frame(0, 'ok', true)];
        });

        const result = await transport.allocPty({
            sessionId: 'pty-forward',
            command: 'echo ok',
            cols: 120,
            rows: 40,
        });

        expect(result).toHaveLength(1);
        expect(received).toHaveLength(1);
        const first = received[0];
        expect(first?.sessionId).toBe('pty-forward');
        expect(first?.command).toBe('echo ok');
    });
});

type PtyAllocRequestLike = {
    readonly sessionId: string;
    readonly command?: string;
    readonly cwd?: string;
    readonly cols?: number;
    readonly rows?: number;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
};
