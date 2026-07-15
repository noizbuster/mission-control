import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    encodeSessionOwnerControlFrame,
    parseSessionOwnerControlFrame,
    SESSION_OWNER_CONTROL_MAX_FRAME_BYTES,
    SessionOwnerControlFrameError,
} from './session-owner-control-framing';

describe('session owner control NDJSON framing', () => {
    it('emits one compact UTF-8 JSON value followed by one newline', () => {
        expect(encodeSessionOwnerControlFrame({ version: 1, method: 'session.stop' }).toString('utf8')).toBe(
            '{"version":1,"method":"session.stop"}\n',
        );
    });

    it('rejects oversized frames and schema-invalid decoded values', () => {
        expect(() =>
            encodeSessionOwnerControlFrame({ value: 'x'.repeat(SESSION_OWNER_CONTROL_MAX_FRAME_BYTES) }),
        ).toThrow(SessionOwnerControlFrameError);
        expect(() => parseSessionOwnerControlFrame(z.object({ ok: z.literal(true) }).strict(), { ok: false })).toThrow(
            SessionOwnerControlFrameError,
        );
    });
});
