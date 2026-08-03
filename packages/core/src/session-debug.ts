import type { AgentEvent, SessionDebugConfig } from '@mission-control/protocol';
import type { NativeSessionDebugHandle, NativesClient } from './native/natives-client';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';

const MAX_NATIVE_FRAME_BYTES = 4096 - 20 - 4;
const SESSION_ID_PATTERN = /session_[A-Za-z0-9_-]+/g;

type NativeSessionDebugOpener = Pick<NativesClient, 'openSessionDebug'>;

type DebugPayload = {
    readonly event?: unknown;
} & Record<string, unknown>;

export type SessionDebugCapture = {
    capture(event: AgentEvent): void;
    writeFatal(error: unknown): void;
    close(): void;
};

export type CreateSessionDebugCaptureOptions = {
    readonly config: SessionDebugConfig;
    readonly dataDir: string;
    readonly sessionId: string;
    readonly natives: NativeSessionDebugOpener;
};

/**
 * Opens session-scoped, native-owned diagnostic capture. This boundary never
 * exposes file descriptors and drops all capture failures so diagnostics cannot
 * affect agent execution.
 */
export function createSessionDebugCapture(options: CreateSessionDebugCaptureOptions): SessionDebugCapture | undefined {
    if (!options.config.enabled) {
        return undefined;
    }

    let handle: NativeSessionDebugHandle | null;
    try {
        handle = options.natives.openSessionDebug({
            root: options.dataDir,
            sessionKeyDigest: sessionKeyDigest(options.sessionId),
            captureEpoch: randomBytes(16).toString('hex'),
            maxBytes: options.config.maxBytes,
        });
    } catch {
        return undefined;
    }
    if (handle === null) {
        return undefined;
    }

    return captureForHandle(handle, options.sessionId);
}

function captureForHandle(handle: NativeSessionDebugHandle, sessionId: string): SessionDebugCapture {
    return {
        capture(event: AgentEvent): void {
            const payload = encodeBoundedPayload({
                kind: 'event',
                timestamp: event.timestamp,
                event: scrubSessionIdentifiers(event, sessionId),
            });
            try {
                handle.tryEnqueue(payload);
            } catch {
                // Debug capture is observational and must not affect execution.
            }
        },
        writeFatal(error: unknown): void {
            const message = error instanceof Error ? error.message : String(error);
            try {
                handle.writeFatal(
                    encodeBoundedPayload({
                        kind: 'fatal',
                        message: scrubSessionIdentifiers(message, sessionId),
                    }),
                );
            } catch {
                // Debug capture is observational and must not affect execution.
            }
        },
        close(): void {
            try {
                handle.close();
            } catch {
                // Debug capture is observational and must not affect execution.
            }
        },
    };
}

function sessionKeyDigest(sessionId: string): string {
    return createHash('sha256').update(sessionId).digest('hex');
}

function encodeBoundedPayload(value: DebugPayload): Buffer {
    const serialized = JSON.stringify(value);
    const payload = Buffer.from(serialized, 'utf8');
    if (payload.byteLength <= MAX_NATIVE_FRAME_BYTES) {
        return payload;
    }
    const event = value.event;
    const eventType = typeof event === 'object' && event !== null && 'type' in event ? event.type : undefined;
    return Buffer.from(
        JSON.stringify({
            kind: 'truncated',
            originalBytes: payload.byteLength,
            eventType,
        }),
        'utf8',
    );
}

function scrubSessionIdentifiers(value: unknown, currentSessionId: string): unknown {
    if (typeof value === 'string') {
        return value.replaceAll(currentSessionId, '<session>').replace(SESSION_ID_PATTERN, '<session>');
    }
    if (Array.isArray(value)) {
        return value.map((entry) => scrubSessionIdentifiers(entry, currentSessionId));
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key,
            key === 'sessionId' || key === 'session_id'
                ? '<session>'
                : scrubSessionIdentifiers(entry, currentSessionId),
        ]),
    );
}

export const sessionDebugInternal = {
    encodeBoundedPayload,
    scrubSessionIdentifiers,
    sessionKeyDigest,
};
