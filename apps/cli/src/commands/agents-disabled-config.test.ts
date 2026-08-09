import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDisabledSet, toggleDisabled } from './agents-disabled-config';

describe('agents-disabled-config concurrent RMW', () => {
    it('serializes concurrent toggleDisabled without dropping names', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'mctrl-disabled-'));
        const options = { workspaceRoot: dir, disabledConfigPath: join(dir, 'agents.disabled') };
        await Promise.all([
            toggleDisabled(options, 'a', 'add'),
            toggleDisabled(options, 'b', 'add'),
            toggleDisabled(options, 'c', 'add'),
        ]);
        const set = await readDisabledSet(options);
        expect([...set].sort()).toEqual(['a', 'b', 'c']);
    });
});
