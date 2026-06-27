/**
 * T8 failing-first proof: slash-command palette mapping table coverage.
 *
 * The command palette component itself (command-palette.tsx) cannot be rendered
 * in unit tests: apps/cli has no react-dom / react-test-renderer / DOM test
 * environment, the plan forbids adding deps, and command-palette.tsx imports
 * `@opentui/react` (which eagerly loads the native FFI core). So T8 pins the
 * palette's correctness at the CLASSIFICATION layer (slash-mapping.ts): this
 * suite asserts the mapping table COVERS every slashCommandChoices entry and
 * that the registry-slash set is exactly the argument-less palette-eligible
 * commands. The component reads this table, so a green suite means the palette
 * lists exactly the right slash commands.
 *
 * Adversarial coverage (per task spec):
 *  - misleading_success_output: assert the table COVERS EVERY slashCommandChoices
 *    entry (not just "some"), and that the registry-slash set EXACTLY equals the
 *    pinned argument-less set — not merely "non-empty".
 *  - malformed_input: an unknown command name is NOT palette-eligible and does
 *    not throw.
 *  - execution-truth cross-check: each registry-slash name, invoked bare, must
 *    NOT parse to `invalid` in parseChatLine (proving it is runnable without an
 *    argument — parseChatLine is the EXECUTION truth, the table is DISPLAY truth).
 */

import { describe, expect, it } from 'vitest';
import { parseChatLine } from '../../commands/chat-commands.js';
import { slashCommandChoices } from '../../commands/interactive-chat-command-menu.js';
import {
    ALL_SLASH_BASE_NAMES,
    classifySlashCommand,
    getPaletteSlashCommands,
    isPaletteSlashCommand,
    PALETTE_SLASH_NAMES,
    slashBaseName,
} from './slash-mapping.js';

/**
 * Independently derive the base-name set from the slash menu so the coverage
 * assertion is not circular with the module's own `ALL_SLASH_BASE_NAMES`.
 */
function deriveBaseNames(ids: readonly string[]): Set<string> {
    return new Set(ids.map(slashBaseName));
}

describe('T8 slash-command palette mapping table', () => {
    it('module base-name set matches the independently-derived set (coverage foundation)', () => {
        const expected = deriveBaseNames(slashCommandChoices.map((choice) => choice.id));
        expect(ALL_SLASH_BASE_NAMES).toEqual(expected);
        expect(ALL_SLASH_BASE_NAMES.size).toBeGreaterThan(0);
    });

    it('classifies EVERY slashCommandChoices base name (coverage / misleading-success guard)', () => {
        for (const choice of slashCommandChoices) {
            const base = slashBaseName(choice.id);
            const classification = classifySlashCommand(base);
            // Every base name resolves to exactly one bucket — never throws,
            // never an unknown sentinel. This is the "every entry classified" gate.
            expect(classification === 'registry-slash' || classification === 'parsechatline-only').toBe(true);
        }
    });

    it('partitions base names: registry-slash XOR parsechatline-only, helpers agree (stale-state guard)', () => {
        for (const base of ALL_SLASH_BASE_NAMES) {
            const isPalette = isPaletteSlashCommand(base);
            const classification = classifySlashCommand(base);
            // isPaletteSlashCommand and classifySlashCommand MUST agree, so the
            // two buckets never overlap and never leave a gap.
            expect(isPalette).toBe(classification === 'registry-slash');
        }
    });

    it('registry-slash set EXACTLY equals the pinned argument-less commands', () => {
        expect(PALETTE_SLASH_NAMES).toEqual(
            new Set<string>([
                'exit',
                'help',
                'hotkeys',
                'compact',
                'continue',
                'interrupt',
                'resume',
                'sessions',
                'tree',
            ]),
        );
    });

    it('registry-slash names are all real slashCommandChoices entries (no phantom names)', () => {
        const knownBases = deriveBaseNames(slashCommandChoices.map((choice) => choice.id));
        for (const name of PALETTE_SLASH_NAMES) {
            expect(knownBases.has(name)).toBe(true);
        }
    });

    it('registry-slash names are runnable bare in parseChatLine (cross-check vs execution truth)', () => {
        // The display truth (table) must agree with the execution truth
        // (parseChatLine): every palette-eligible slash command parses to a
        // real action, never `invalid`, when invoked with no argument.
        for (const name of PALETTE_SLASH_NAMES) {
            const action = parseChatLine(`/${name}`);
            expect(action.kind).not.toBe('invalid');
        }
    });

    it('getPaletteSlashCommands returns exactly the registry-slash set, sorted, with /name display', () => {
        const entries = getPaletteSlashCommands();
        expect(entries).toHaveLength(PALETTE_SLASH_NAMES.size);
        const names = entries.map((entry) => entry.slashName);
        expect(names).toEqual([...PALETTE_SLASH_NAMES].sort());
        for (const entry of entries) {
            expect(PALETTE_SLASH_NAMES.has(entry.slashName)).toBe(true);
            expect(entry.display).toBe(`/${entry.slashName}`);
            expect(entry.description.length).toBeGreaterThan(0);
        }
    });

    it('isPaletteSlashCommand is false for arg-taking commands and unknown names (malformed-input guard)', () => {
        // Arg-taking / subcommand / history bases stay parseChatLine-only.
        const argBases = [
            'model',
            'export',
            'rename',
            'queue',
            'steer',
            'trust',
            'approval',
            'branch',
            'fork',
            'clone',
            'session',
            'new',
            'clear',
            'undo',
            'redo',
        ];
        for (const base of argBases) {
            expect(isPaletteSlashCommand(base)).toBe(false);
        }
        // Unknown / malformed names are NOT palette-eligible and do not throw.
        expect(isPaletteSlashCommand('nonexistent')).toBe(false);
        expect(isPaletteSlashCommand('')).toBe(false);
        expect(() => isPaletteSlashCommand('model pick')).not.toThrow();
    });

    it('slashBaseName strips the leading slash and any subcommand tail', () => {
        expect(slashBaseName('/exit')).toBe('exit');
        expect(slashBaseName('/model pick')).toBe('model');
        expect(slashBaseName('/trust deny')).toBe('trust');
        expect(slashBaseName('/approval verbose')).toBe('approval');
    });
});
