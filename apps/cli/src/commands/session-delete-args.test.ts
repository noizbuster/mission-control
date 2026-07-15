import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args';

describe('session delete argument parsing', () => {
    it('parses delete with session id', () => {
        const result = parseArgs(['session', 'delete', 'session_cli']);
        expect(result).toMatchObject({
            command: 'session-delete',
            sessionId: 'session_cli',
        });
    });

    it('rejects unsupported arguments after the session id', () => {
        expect(() => parseArgs(['session', 'delete', 'session_cli', '--force'])).toThrow(
            'Unsupported session delete argument: --force',
        );
    });
});
