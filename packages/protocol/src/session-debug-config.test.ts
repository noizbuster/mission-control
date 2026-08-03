import {
    SESSION_DEBUG_MAX_BYTES,
    SESSION_DEBUG_MIN_BYTES,
    SessionDebugConfigSchema,
} from './mcp-config';
import { describe, expect, it } from 'vitest';

describe('SessionDebugConfigSchema', () => {
    it('defaults to disabled diagnostics with bounded retention', () => {
        expect(SessionDebugConfigSchema.parse({})).toEqual({
            enabled: false,
            maxBytes: SESSION_DEBUG_MAX_BYTES,
            retentionDays: 30,
        });
    });

    it('rejects out-of-range or unknown values', () => {
        expect(SessionDebugConfigSchema.safeParse({ maxBytes: SESSION_DEBUG_MIN_BYTES - 1 }).success).toBe(false);
        expect(SessionDebugConfigSchema.safeParse({ maxBytes: SESSION_DEBUG_MAX_BYTES + 1 }).success).toBe(false);
        expect(SessionDebugConfigSchema.safeParse({ retentionDays: 0 }).success).toBe(false);
        expect(SessionDebugConfigSchema.safeParse({ retentionDays: 366 }).success).toBe(false);
        expect(SessionDebugConfigSchema.safeParse({ unexpected: true }).success).toBe(false);
    });
});
