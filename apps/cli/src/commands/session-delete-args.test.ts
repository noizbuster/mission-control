import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';

describe('session delete argument parsing', () => {
    it('parses delete with session id', () => {
        const result = parseArgs(['session', 'delete', 'session_cli']);
        expect(result).toMatchObject({
            command: 'session-delete',
            sessionId: 'session_cli',
        });
        expect(result.force).toBeUndefined();
    });

    it('parses delete with --force', () => {
        expect(parseArgs(['session', 'delete', 'session_cli', '--force'])).toMatchObject({
            command: 'session-delete',
            sessionId: 'session_cli',
            force: true,
        });
    });

    it('rejects extra arguments after --force', () => {
        expect(() => parseArgs(['session', 'delete', 'session_cli', '--force', 'extra'])).toThrow(
            'Unsupported session delete argument: extra',
        );
    });
});
