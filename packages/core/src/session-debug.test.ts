import { AgentEventSchema, SessionDebugConfigSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { NativeSessionDebugHandle } from './native/natives-client';
import { createSessionDebugCapture, sessionDebugInternal } from './session-debug';
import { createHash } from 'node:crypto';

const sessionId = 'session_0123456789abcdef';

function createHandle(): {
    readonly handle: NativeSessionDebugHandle;
    readonly frames: Uint8Array[];
    readonly fatals: Uint8Array[];
} {
    const frames: Uint8Array[] = [];
    const fatals: Uint8Array[] = [];
    const handle: NativeSessionDebugHandle = {
        tryEnqueue(payload): boolean {
            frames.push(payload);
            return true;
        },
        writeFatal(payload): boolean {
            fatals.push(payload);
            return true;
        },
        status: { enabled: true, sequence: 0, traceCapacityBytes: 1024 },
        close(): void {},
    };
    return { handle, frames, fatals };
}

describe('createSessionDebugCapture', () => {
    it('does not acquire native diagnostics when configuration is disabled', () => {
        let opened = false;
        const capture = createSessionDebugCapture({
            config: SessionDebugConfigSchema.parse({ enabled: false }),
            dataDir: '/safe/data',
            sessionId,
            natives: {
                openSessionDebug: () => {
                    opened = true;
                    return null;
                },
            },
        });

        expect(capture).toBeUndefined();
        expect(opened).toBe(false);
    });

    it('degrades to disabled capture when native acquisition throws', () => {
        expect(() =>
            createSessionDebugCapture({
                config: SessionDebugConfigSchema.parse({ enabled: true, maxBytes: 32 * 1024 * 1024 }),
                dataDir: '/safe/data',
                sessionId,
                natives: {
                    openSessionDebug: () => {
                        throw new Error('native storage unavailable');
                    },
                },
            }),
        ).not.toThrow();
    });

    it('uses a session-key digest and captures redacted, bounded events', () => {
        const { handle, frames, fatals } = createHandle();
        let openOptions:
            | {
                  readonly root: string;
                  readonly sessionKeyDigest: string;
                  readonly captureEpoch: string;
                  readonly maxBytes: number;
              }
            | undefined;
        const capture = createSessionDebugCapture({
            config: SessionDebugConfigSchema.parse({ enabled: true, maxBytes: 32 * 1024 * 1024 }),
            dataDir: '/safe/data',
            sessionId,
            natives: {
                openSessionDebug: (options) => {
                    openOptions = options;
                    return handle;
                },
            },
        });

        capture?.capture(
            AgentEventSchema.parse({
                type: 'session.started',
                timestamp: '2026-08-04T00:00:00.000Z',
                sessionId,
                message: `started ${sessionId}`,
            }),
        );
        capture?.writeFatal(new Error(`fatal ${sessionId}`));

        expect(openOptions?.sessionKeyDigest).toBe(createHash('sha256').update(sessionId).digest('hex'));
        expect(openOptions?.captureEpoch).toMatch(/^[0-9a-f]{32}$/);
        expect(new TextDecoder().decode(frames[0])).not.toContain(sessionId);
        expect(new TextDecoder().decode(fatals[0])).not.toContain(sessionId);
    });

    it('replaces an oversized event with bounded metadata', () => {
        const payload = sessionDebugInternal.encodeBoundedPayload({
            event: { type: 'provider.chunk' },
            content: 'x'.repeat(10_000),
        });

        expect(payload.byteLength).toBeLessThanOrEqual(4096 - 20 - 4);
        expect(JSON.parse(new TextDecoder().decode(payload))).toMatchObject({
            kind: 'truncated',
            eventType: 'provider.chunk',
        });
    });

    it('scrubs direct and embedded session identifiers', () => {
        expect(
            sessionDebugInternal.scrubSessionIdentifiers(
                { sessionId, note: `child session_abcdef is related to ${sessionId}` },
                sessionId,
            ),
        ).toEqual({ sessionId: '<session>', note: 'child <session> is related to <session>' });
    });
});
