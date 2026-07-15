import type { TuiPluginCommandDescriptor } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { buildPaletteItems, filterPaletteItems } from './command-palette';

describe('command palette provider items', () => {
    it('merges keymap, slash, and plugin commands into one searchable list', () => {
        const pluginCommands: readonly TuiPluginCommandDescriptor[] = [
            { id: 'demo.run', title: 'Run Demo', paletteSection: 'Demo Plugin' },
        ];

        const items = buildPaletteItems(
            [{ kind: 'keymap', name: 'messages.copy', title: 'Copy Last Assistant', description: 'Copy text' }],
            [{ slashName: 'agents', display: '/agents', description: 'Manage agents' }],
            pluginCommands,
        );

        expect(items.map((item) => item.kind)).toEqual(['keymap', 'slash', 'plugin']);
        expect(filterPaletteItems(items, 'demo').map((item) => item.kind)).toEqual(['plugin']);
        expect(filterPaletteItems(items, 'agents').map((item) => item.kind)).toEqual(['slash']);
    });
});
