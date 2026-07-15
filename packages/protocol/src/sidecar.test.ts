import { describe, expect, it } from 'vitest';
import {
    SIDECAR_PROTOCOL_V2_VERSION,
    SIDECAR_PROTOCOL_V3_VERSION,
    SIDECAR_PROTOCOL_VERSION,
    SidecarCancelTaskCommandSchema,
    SidecarHandshakeCommandSchema,
    SidecarHandshakeResponseSchema,
    SidecarIsoDiffRequestSchema,
    SidecarIsoDiffResponseSchema,
    SidecarIsoResolveRequestSchema,
    SidecarIsoResolveResponseSchema,
    SidecarPtyAllocRequestSchema,
    SidecarShellOutputSchema,
    SidecarShellRunRequestSchema,
    SidecarStreamCloseCommandSchema,
    SidecarStreamFrameResponseSchema,
    SidecarStreamFrameSchema,
    SidecarStreamOpenRequestSchema,
    SidecarTaskCancelledResponseSchema,
    SidecarTaskFailedResponseSchema,
    SidecarWireResponseSchema,
    validateSidecarStreamFrames,
} from './schema';

describe('sidecar protocol versions', () => {
    it('keeps v1 handshake compatibility limited to task.run', () => {
        const command = SidecarHandshakeCommandSchema.parse({
            type: 'handshake',
            id: 'handshake_v1',
            payload: {
                protocolVersion: SIDECAR_PROTOCOL_VERSION,
                clientName: 'mission-control-core',
            },
        });
        const response = SidecarHandshakeResponseSchema.parse({
            type: 'handshake_completed',
            id: 'handshake_v1',
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            capabilities: ['task.run'],
        });
        const rejected = SidecarHandshakeResponseSchema.safeParse({
            type: 'handshake_completed',
            id: 'handshake_v1',
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            capabilities: ['task.cancel'],
        });

        expect(command.payload.protocolVersion).toBe(SIDECAR_PROTOCOL_VERSION);
        expect(response.capabilities).toEqual(['task.run']);
        expect(rejected.success).toBe(false);
    });

    it('parses v2 negotiation, failure, and cancellation wire contracts', () => {
        const command = SidecarHandshakeCommandSchema.parse({
            type: 'handshake',
            id: 'handshake_v2',
            payload: {
                protocolVersion: SIDECAR_PROTOCOL_V2_VERSION,
                clientName: 'mission-control-core',
                requestedCapabilities: ['task.cancel'],
            },
        });
        const handshake = SidecarHandshakeResponseSchema.parse({
            type: 'handshake_completed',
            id: 'handshake_v2',
            protocolVersion: SIDECAR_PROTOCOL_V2_VERSION,
            capabilities: ['task.run', 'task.cancel'],
        });
        const cancelCommand = SidecarCancelTaskCommandSchema.parse({
            type: 'cancel_task',
            id: 'cancel_1',
            payload: {
                taskId: 'task_1',
                reason: 'user stopped task',
            },
        });
        const failed = SidecarTaskFailedResponseSchema.parse({
            type: 'task_failed',
            id: 'task_1',
            error: {
                code: 'sidecar_failed',
                message: 'provider process exited',
                retryable: false,
            },
        });
        const cancelled = SidecarTaskCancelledResponseSchema.parse({
            type: 'task_cancelled',
            id: 'task_1',
            reason: 'user stopped task',
        });

        expect(command.payload.requestedCapabilities).toEqual(['task.cancel']);
        expect(handshake.capabilities).toEqual(['task.run', 'task.cancel']);
        expect(cancelCommand.payload.taskId).toBe('task_1');
        expect(failed.error.retryable).toBe(false);
        expect(cancelled.reason).toBe('user stopped task');
        expect(SidecarWireResponseSchema.parse(failed)).toEqual(failed);
        expect(SidecarWireResponseSchema.parse(cancelled)).toEqual(cancelled);
    });
});

describe('sidecar protocol v3 handshake', () => {
    it('parses v3 handshake with shell/pty/iso capabilities', () => {
        const command = SidecarHandshakeCommandSchema.parse({
            type: 'handshake',
            id: 'handshake_v3',
            payload: {
                protocolVersion: SIDECAR_PROTOCOL_V3_VERSION,
                clientName: 'mission-control-core',
            },
        });
        const response = SidecarHandshakeResponseSchema.parse({
            type: 'handshake_completed',
            id: 'handshake_v3',
            protocolVersion: SIDECAR_PROTOCOL_V3_VERSION,
            capabilities: ['task.run', 'task.cancel', 'shell.session', 'pty.alloc', 'iso.resolve'],
        });

        expect(command.payload.protocolVersion).toBe(SIDECAR_PROTOCOL_V3_VERSION);
        expect(response.capabilities).toContain('shell.session');
        expect(response.capabilities).toContain('pty.alloc');
        expect(response.capabilities).toContain('iso.resolve');
    });

    it('accepts a partial v3 capability set (client enforces negotiation)', () => {
        const result = SidecarHandshakeResponseSchema.safeParse({
            type: 'handshake_completed',
            id: 'handshake_v3',
            protocolVersion: SIDECAR_PROTOCOL_V3_VERSION,
            capabilities: ['task.run', 'task.cancel'],
        });

        expect(result.success).toBe(true);
    });

    it('rejects v3 handshake with empty capabilities', () => {
        const result = SidecarHandshakeResponseSchema.safeParse({
            type: 'handshake_completed',
            id: 'handshake_v3',
            protocolVersion: SIDECAR_PROTOCOL_V3_VERSION,
            capabilities: [],
        });

        expect(result.success).toBe(false);
    });

    it('rejects v3 handshake with an unknown capability', () => {
        const result = SidecarHandshakeResponseSchema.safeParse({
            type: 'handshake_completed',
            id: 'handshake_v3',
            protocolVersion: SIDECAR_PROTOCOL_V3_VERSION,
            capabilities: ['task.run', 'shell.session', 'process.exec'],
        });

        expect(result.success).toBe(false);
    });
});

describe('SidecarStreamFrame', () => {
    it('parses a valid frame', () => {
        const frame = SidecarStreamFrameSchema.parse({
            sessionId: 's1',
            seq: 0,
            payload: 'hello',
            end: false,
        });

        expect(frame.sessionId).toBe('s1');
        expect(frame.seq).toBe(0);
        expect(frame.payload).toBe('hello');
        expect(frame.end).toBe(false);
        expect(frame.error).toBeUndefined();
    });

    it('parses a terminal error frame', () => {
        const frame = SidecarStreamFrameSchema.parse({
            sessionId: 's1',
            seq: 2,
            payload: '',
            end: true,
            error: 'process exited 1',
        });

        expect(frame.end).toBe(true);
        expect(frame.error).toBe('process exited 1');
    });

    it('rejects negative seq', () => {
        const result = SidecarStreamFrameSchema.safeParse({
            sessionId: 's1',
            seq: -1,
            payload: 'x',
            end: false,
        });

        expect(result.success).toBe(false);
    });

    it('rejects non-integer seq', () => {
        const result = SidecarStreamFrameSchema.safeParse({
            sessionId: 's1',
            seq: 1.5,
            payload: 'x',
            end: false,
        });

        expect(result.success).toBe(false);
    });

    it('rejects empty sessionId', () => {
        const result = SidecarStreamFrameSchema.safeParse({
            sessionId: '',
            seq: 0,
            payload: 'x',
            end: false,
        });

        expect(result.success).toBe(false);
    });

    it('parses the wire response variant with type tag', () => {
        const response = SidecarStreamFrameResponseSchema.parse({
            type: 'stream_frame',
            sessionId: 's1',
            seq: 0,
            payload: 'x',
            end: false,
        });

        expect(response.type).toBe('stream_frame');
        expect(response.seq).toBe(0);
    });
});

describe('validateSidecarStreamFrames', () => {
    it('accepts a monotonic stream ending with end:true', () => {
        const frames = [
            { sessionId: 's1', seq: 0, payload: 'a', end: false },
            { sessionId: 's1', seq: 1, payload: 'b', end: false },
            { sessionId: 's1', seq: 2, payload: 'c', end: true },
        ];

        expect(() => validateSidecarStreamFrames(frames)).not.toThrow();
    });

    it('rejects duplicate seq', () => {
        const frames = [
            { sessionId: 's1', seq: 0, payload: 'a', end: false },
            { sessionId: 's1', seq: 0, payload: 'b', end: true },
        ];

        expect(() => validateSidecarStreamFrames(frames)).toThrow(/strictly increasing/);
    });

    it('rejects end:false after a prior end:true', () => {
        const frames = [
            { sessionId: 's1', seq: 0, payload: 'a', end: true },
            { sessionId: 's1', seq: 1, payload: 'b', end: false },
        ];

        expect(() => validateSidecarStreamFrames(frames)).toThrow(/after terminal end/);
    });

    it('rejects out-of-order seq', () => {
        const frames = [
            { sessionId: 's1', seq: 2, payload: 'c', end: false },
            { sessionId: 's1', seq: 1, payload: 'b', end: true },
        ];

        expect(() => validateSidecarStreamFrames(frames)).toThrow(/strictly increasing/);
    });

    it('accepts a single terminal frame', () => {
        const frames = [{ sessionId: 's1', seq: 0, payload: 'done', end: true }];

        expect(() => validateSidecarStreamFrames(frames)).not.toThrow();
    });

    it('accepts an empty stream', () => {
        expect(() => validateSidecarStreamFrames([])).not.toThrow();
    });
});

describe('sidecar v3 capability request/response shapes', () => {
    it('parses stream_open and stream_close commands', () => {
        const open = SidecarStreamOpenRequestSchema.parse({
            type: 'stream_open',
            id: 'open_1',
            payload: {
                sessionId: 'sess_a',
                kind: 'shell',
                command: 'echo hello',
            },
        });
        const close = SidecarStreamCloseCommandSchema.parse({
            type: 'stream_close',
            id: 'close_1',
            payload: {
                sessionId: 'sess_a',
                reason: 'user cancelled',
            },
        });

        expect(open.payload.kind).toBe('shell');
        expect(open.payload.command).toBe('echo hello');
        expect(close.payload.sessionId).toBe('sess_a');
    });

    it('parses shell and pty request shapes', () => {
        const shellRun = SidecarShellRunRequestSchema.parse({
            sessionId: 'sess_b',
            command: 'ls -la',
            cwd: '/tmp',
        });
        const shellOutput = SidecarShellOutputSchema.parse({
            stream: 'stdout',
            text: 'total 0',
        });
        const ptyAlloc = SidecarPtyAllocRequestSchema.parse({
            sessionId: 'sess_c',
            cols: 80,
            rows: 24,
        });

        expect(shellRun.command).toBe('ls -la');
        expect(shellOutput.stream).toBe('stdout');
        expect(ptyAlloc.cols).toBe(80);
    });

    it('parses iso_resolve and iso_diff request/response pairs', () => {
        const resolveReq = SidecarIsoResolveRequestSchema.parse({
            type: 'iso_resolve',
            id: 'iso_1',
            payload: { target: '/workspace' },
        });
        const resolveRes = SidecarIsoResolveResponseSchema.parse({
            type: 'iso_resolved',
            id: 'iso_1',
            payload: { resolved: '/workspace', method: 'bind' },
        });
        const diffReq = SidecarIsoDiffRequestSchema.parse({
            type: 'iso_diff',
            id: 'iso_2',
            payload: { target: '/workspace', baseline: 'a', current: 'b' },
        });
        const diffRes = SidecarIsoDiffResponseSchema.parse({
            type: 'iso_diffed',
            id: 'iso_2',
            payload: { diff: '-a\n+b', identical: false },
        });

        expect(resolveReq.payload.target).toBe('/workspace');
        expect(resolveRes.payload.method).toBe('bind');
        expect(diffReq.payload.baseline).toBe('a');
        expect(diffRes.payload.identical).toBe(false);
    });
});
