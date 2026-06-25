/**
 * T18 deliverable (c): race/timing invariant index + locatability gate.
 *
 * The four safety-critical race/timing invariants of the opentui keymap port
 * CANNOT be asserted through tmux (they are timing/race contracts, not
 * deterministic chord delivery). They are each locked by a unit test driven
 * through the `createRecordingTextarea` / `makeKeyEvent` seam. Those tests are
 * SCATTERED across two files (T3 in keymap-managed-layer.test.ts, T16 in
 * opentui-chat-bridge-esc-ctrl-c-contracts.test.ts).
 *
 * This file is the consolidated INDEX. It:
 *   1. Documents every invariant + its exact test location (the map a reviewer
 *      reads to find them).
 *   2. Acts as a locatability gate: it reads the two invariant-test source
 *      files and asserts each invariant's test block is still present by name.
 *      If an invariant loses its test (deleted or renamed), this index turns
 *      RED so the gap is surfaced instead of silently vanishing.
 *
 * This is a meta-gate by design: it does NOT re-implement the invariant logic
 * (that lives in the dedicated, FFI-free test files and would drift if copied).
 * It guarantees the invariants remain LOCATED and named, which is the index's
 * job. Running the underlying files (`pnpm exec vitest run <file>`) is what
 * proves the contracts hold.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COMMANDS_DIR = resolve(__dirname, '../../commands');
const KEYMAP_DIR = resolve(__dirname);

const MANAGED_LAYER_TEST = resolve(KEYMAP_DIR, 'keymap-managed-layer.test.ts');
const ESC_CTRL_C_TEST = resolve(COMMANDS_DIR, 'opentui-chat-bridge-esc-ctrl-c-contracts.test.ts');
const MULTILINE_TEST = resolve(COMMANDS_DIR, 'opentui-chat-bridge-multiline.test.ts');

interface InvariantSpec {
    /** Short invariant id used in the index. */
    readonly id: string;
    /** Human description of the race/timing contract. */
    readonly contract: string;
    /** Test file (relative to repo root) that locks it. */
    readonly file: string;
    /** Absolute path read for the locatability check. */
    readonly absPath: string;
    /** Substring(s) that MUST appear in the file for the invariant to be "located". */
    readonly markers: readonly string[];
    /** The seam the test uses. */
    readonly seam: 'createRecordingTextarea' | 'makeKeyEvent';
}

/**
 * The four race/timing invariants. Every entry MUST map to a real, named test
 * block in the referenced file. Mirrors section 17 of the parity matrix.
 */
const INVARIANTS: readonly InvariantSpec[] = [
    {
        id: 'ctrl-c-double-enqueue',
        contract:
            'Ctrl+C routes through the global useKeyboard sink (the keymap layer MUST NOT bind ctrl+c) and produces exactly ONE interrupt with source ctrl-c and ZERO clear effects on the textarea.',
        file: 'apps/cli/src/platform/keymap/keymap-managed-layer.test.ts',
        absPath: MANAGED_LAYER_TEST,
        markers: [
            'T3 (a) Ctrl+C routes through global sink with exactly one interrupt',
            'enqueues exactly ONE interrupt with source ctrl-c when the textarea has text',
            'does NOT clear the textarea (zero clear effects)',
        ],
        seam: 'createRecordingTextarea',
    },
    {
        id: 'double-enter-submitting-guard',
        contract:
            'Firing the custom submit command twice in the same tick produces exactly ONE enqueued line — the submitting guard in bridgeSubmit deduplicates a fast double-Enter.',
        file: 'apps/cli/src/platform/keymap/keymap-managed-layer.test.ts',
        absPath: MANAGED_LAYER_TEST,
        markers: [
            'T3 (b) custom submit command submitting guard',
            'enqueues exactly ONE line when submit is fired twice in the same tick',
        ],
        seam: 'createRecordingTextarea',
    },
    {
        id: 'ime-defer-no-op',
        contract:
            'A submit arriving while core.submitting is already true (the mid-IME double-setTimeout defer window) is a no-op — zero enqueues.',
        file: 'apps/cli/src/platform/keymap/keymap-managed-layer.test.ts',
        absPath: MANAGED_LAYER_TEST,
        markers: [
            'T3 (c) submit during IME submitting window is a no-op',
            'does not enqueue when core.submitting is already true',
        ],
        seam: 'createRecordingTextarea',
    },
    {
        id: 'double-esc-window',
        contract:
            'A second Escape within the 500ms window fires the configured double-Esc action (interrupt/tree/fork); outside the window it does not fire. Driven with fake timers.',
        file: 'apps/cli/src/commands/opentui-chat-bridge-esc-ctrl-c-contracts.test.ts',
        absPath: ESC_CTRL_C_TEST,
        markers: [
            'T16 contract: double-Esc within 500ms fires configured action (fake timers)',
            'fires the default interrupt action on double-Esc within the 500ms window',
            'does NOT fire when the second Esc falls outside the 500ms window',
        ],
        seam: 'makeKeyEvent',
    },
] as const;

function readSource(path: string): string {
    return readFileSync(path, 'utf-8');
}

describe('T18 race/timing invariant index', () => {
    it('indexes exactly the four safety-critical invariants', () => {
        expect(INVARIANTS).toHaveLength(4);
        const ids = INVARIANTS.map((spec) => spec.id);
        expect(ids).toEqual(
            expect.arrayContaining([
                'ctrl-c-double-enqueue',
                'double-enter-submitting-guard',
                'ime-defer-no-op',
                'double-esc-window',
            ]),
        );
    });

    it('every invariant points at a file that exists and uses the recorded seam', () => {
        for (const spec of INVARIANTS) {
            const source = readSource(spec.absPath);
            // The file imports the named seam (createRecordingTextarea / makeKeyEvent).
            expect(source).toContain(spec.seam);
        }
    });

    it('every invariant test block is still located by name (locatability gate)', () => {
        // The misleading_success guard: each marker MUST be present in the
        // referenced file. A deleted/renamed invariant test turns this red.
        const missing: string[] = [];
        for (const spec of INVARIANTS) {
            const source = readSource(spec.absPath);
            for (const marker of spec.markers) {
                if (!source.includes(marker)) {
                    missing.push(`${spec.id} @ ${spec.file}: missing "${marker}"`);
                }
            }
        }
        expect(missing, `invariant test(s) not located:\n${missing.join('\n')}`).toEqual([]);
    });

    it('the IME double-defer path is also covered by the multiline bridge suite', () => {
        // bridgeSubmit's double-setTimeout IME defer is the shared mechanism
        // behind both the submitting-guard and the IME-defer invariants. The
        // multiline suite pins it end-to-end with fake timers.
        const source = readSource(MULTILINE_TEST);
        expect(source).toContain('IME-double-deferred');
        expect(source).toContain('bridgeSubmit');
    });

    it('Ctrl+C is deliberately NOT bound by the keymap registry (the global-sink contract)', () => {
        // The invariant's precondition: ctrl+c never enters the keybind
        // catalog, so the layer cannot double-enqueue it. Pinned in keybind.ts.
        const keybind = readSource(resolve(KEYMAP_DIR, 'keybind.ts'));
        expect(keybind).toContain('EXCLUDES `input_clear`/`ctrl+c`');
    });
});
