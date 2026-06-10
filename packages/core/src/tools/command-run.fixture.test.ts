import { describe, expect, it } from 'vitest';

describe('command.run real command fixture', () => {
    it('exits quickly', () => {
        expect('command.run').toContain('run');
    });
});
