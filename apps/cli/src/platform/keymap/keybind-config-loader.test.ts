/**
 * T17 failing-first proof for the rebindable keybind config loader.
 *
 * Mirrors the skill-loader 3-scope first-wins discovery pattern (global config
 * dir -> `.mctrl/keybinds.json` -> `.agents/keybinds.json`) but SYNC (the loader
 * runs at keymap-build time inside `createKeymapInstance`, which is synchronous).
 *
 * Adversarial classes (per task spec):
 *  - malformed_input: APPLIES — bad JSON, unknown keys, and wrong-type values
 *    are each skipped with a diagnostic and NEVER throw.
 *  - misleading_success_output: APPLIES — an override changes BOTH the resolved
 *    binding (`resolveKeybindConfig().keybinds.model_cycle`) AND (in the hotkeys
 *    suite) the `/hotkeys` output. Here we assert the resolved binding changes,
 *    not merely that the file "loaded".
 *  - stale_state: APPLIES — the cache invalidates when the resolved path OR the
 *    file mtime changes (different workspace -> different result).
 *  - others (flaky/prompt_injection/cancel_resume/dirty/hung/repeated): N/A —
 *    synchronous file read, no runtime, no process control.
 *
 * Written BEFORE keybind-config-loader.ts; the import fails until the module
 * exists, which is the red half of the red->green->refactor loop.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keybinds } from './keybind.js';
import {
    clearKeybindConfigCache,
    KEYBIND_CONFIG_FILENAME,
    loadKeybindConfig,
    resolveKeybindConfig,
    resolveKeybindConfigDir,
} from './keybind-config-loader.js';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TempRoot = { readonly workspace: string; readonly userConfig: string };

function makeTempRoot(): TempRoot {
    const base = mkdtempSync(join(tmpdir(), 'mctrl-keybind-cfg-'));
    const workspace = join(base, 'workspace');
    const userConfig = join(base, 'userconfig');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(userConfig, { recursive: true });
    return { workspace, userConfig };
}

function writeKeybinds(dir: string, scopeRel: readonly string[], contents: string): string {
    const target = join(dir, ...scopeRel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents, 'utf8');
    return target;
}

describe('resolveKeybindConfigDir', () => {
    it('honors an explicit userConfigDir override', () => {
        expect(resolveKeybindConfigDir({ userConfigDir: '/custom/cfg' })).toBe('/custom/cfg');
    });

    it('honors MCTRL_CONFIG_DIR from env', () => {
        expect(resolveKeybindConfigDir({ env: { MCTRL_CONFIG_DIR: '/env/cfg' } })).toBe('/env/cfg');
    });
});

describe('T17 keybind config loader', () => {
    let temp: TempRoot;

    beforeEach(() => {
        temp = makeTempRoot();
        clearKeybindConfigCache();
    });
    afterEach(() => {
        clearKeybindConfigCache();
    });

    describe('acceptance (a): a .mctrl override changes the resolved binding', () => {
        it('loads model_cycle=f2 from .mctrl/keybinds.json and parse reflects it', () => {
            writeKeybinds(temp.workspace, ['.mctrl', KEYBIND_CONFIG_FILENAME], '{"model_cycle":"f2"}');

            const { keybinds } = resolveKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            // misleading_success_output guard: assert the OVERRIDDEN value, not
            // merely that the loader returned something.
            expect(keybinds.model_cycle).toBe('f2');
        });

        it('returns catalog defaults when no config file exists', () => {
            const { keybinds, diagnostics } = resolveKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            expect(keybinds.model_cycle).toBe('ctrl+p');
            expect(keybinds).toEqual(Keybinds.parse({}));
            expect(diagnostics).toEqual([]);
        });

        it('reports the resolved source path', () => {
            const path = writeKeybinds(
                temp.workspace,
                ['.mctrl', KEYBIND_CONFIG_FILENAME],
                '{"thinking_toggle":"ctrl+t"}',
            );

            const { sourcePath } = loadKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            expect(sourcePath).toBe(path);
        });

        it('reports null source path when no config file exists', () => {
            const { sourcePath } = loadKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            expect(sourcePath).toBeNull();
        });
    });

    describe('acceptance (b): malformed config is skipped, never throws', () => {
        it('skips an unknown key with a diagnostic and loads the rest', () => {
            writeKeybinds(
                temp.workspace,
                ['.mctrl', KEYBIND_CONFIG_FILENAME],
                '{"model_cycle":"f2","totally_bogus_key":"ctrl+q"}',
            );

            const { overrides, diagnostics } = loadKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            expect(overrides).toMatchObject({ model_cycle: 'f2' });
            expect(overrides).not.toHaveProperty('totally_bogus_key');
            expect(diagnostics.some((d) => d.message.includes('totally_bogus_key'))).toBe(true);
        });

        it('skips a malformed JSON file (no throw, empty overrides)', () => {
            writeKeybinds(temp.workspace, ['.mctrl', KEYBIND_CONFIG_FILENAME], '{ not valid json ]');

            const { overrides, diagnostics } = loadKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            expect(overrides).toEqual({});
            expect(diagnostics.length).toBeGreaterThan(0);
        });

        it('skips a wrong-type value with a diagnostic and loads the rest', () => {
            writeKeybinds(
                temp.workspace,
                ['.mctrl', KEYBIND_CONFIG_FILENAME],
                '{"model_cycle":42,"thinking_toggle":"ctrl+t"}',
            );

            const { overrides, diagnostics } = loadKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            expect(overrides).not.toHaveProperty('model_cycle');
            expect(overrides).toMatchObject({ thinking_toggle: 'ctrl+t' });
            expect(diagnostics.some((d) => d.message.includes('model_cycle'))).toBe(true);
        });

        it('skips a non-object top-level (array) with a diagnostic', () => {
            writeKeybinds(temp.workspace, ['.mctrl', KEYBIND_CONFIG_FILENAME], '["model_cycle"]');

            const { overrides, diagnostics } = loadKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            expect(overrides).toEqual({});
            expect(diagnostics.length).toBeGreaterThan(0);
        });

        it('does not throw under any malformed input shape', () => {
            const shapes = ['null', '42', '"a-string"', 'true', '', '{,}', '{"model_cycle":}'];
            for (const shape of shapes) {
                clearKeybindConfigCache();
                writeKeybinds(temp.workspace, ['.agents', KEYBIND_CONFIG_FILENAME], shape);
                expect(() =>
                    loadKeybindConfig({ workspaceRoot: temp.workspace, userConfigDir: temp.userConfig }),
                ).not.toThrow();
            }
        });
    });

    describe('3-scope first-wins precedence', () => {
        it('global scope wins over .mctrl and .agents', () => {
            writeKeybinds(temp.userConfig, [KEYBIND_CONFIG_FILENAME], '{"model_cycle":"f9"}');
            writeKeybinds(temp.workspace, ['.mctrl', KEYBIND_CONFIG_FILENAME], '{"model_cycle":"f7"}');
            writeKeybinds(temp.workspace, ['.agents', KEYBIND_CONFIG_FILENAME], '{"model_cycle":"f5"}');

            const { keybinds, sourcePath } = resolveKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            expect(keybinds.model_cycle).toBe('f9');
            expect(sourcePath).toBe(join(temp.userConfig, KEYBIND_CONFIG_FILENAME));
        });

        it('.mctrl wins over .agents when no global file exists', () => {
            writeKeybinds(temp.workspace, ['.mctrl', KEYBIND_CONFIG_FILENAME], '{"model_cycle":"f7"}');
            writeKeybinds(temp.workspace, ['.agents', KEYBIND_CONFIG_FILENAME], '{"model_cycle":"f5"}');

            const { keybinds, sourcePath } = resolveKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            expect(keybinds.model_cycle).toBe('f7');
            expect(sourcePath).toBe(join(temp.workspace, '.mctrl', KEYBIND_CONFIG_FILENAME));
        });

        it('falls through a malformed higher-priority scope to the next valid one', () => {
            writeKeybinds(temp.workspace, ['.mctrl', KEYBIND_CONFIG_FILENAME], '{ broken');
            writeKeybinds(temp.workspace, ['.agents', KEYBIND_CONFIG_FILENAME], '{"model_cycle":"f5"}');

            const { keybinds, diagnostics } = resolveKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            // The malformed .mctrl file is skipped (diagnostic emitted); the
            // valid .agents file is loaded instead.
            expect(keybinds.model_cycle).toBe('f5');
            expect(diagnostics.some((d) => d.scope === 'project-mctrl')).toBe(true);
        });
    });

    describe('symlink + size defenses', () => {
        it('skips a symlinked config file (escape defense)', () => {
            const realTarget = writeKeybinds(temp.workspace, ['real-keybinds.json'], '{"model_cycle":"f2"}');
            const linkPath = join(temp.workspace, '.mctrl', KEYBIND_CONFIG_FILENAME);
            mkdirSync(join(temp.workspace, '.mctrl'), { recursive: true });
            symlinkSync(realTarget, linkPath);

            const { overrides, diagnostics } = loadKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
            });

            expect(overrides).toEqual({});
            expect(diagnostics.some((d) => d.message.toLowerCase().includes('symbolic'))).toBe(true);
        });

        it('skips a file exceeding the size bound', () => {
            const huge = `{ "model_cycle": "f2", "padding": "${'x'.repeat(70_000)}" }`;
            writeKeybinds(temp.workspace, ['.mctrl', KEYBIND_CONFIG_FILENAME], huge);

            const { overrides, diagnostics } = loadKeybindConfig({
                workspaceRoot: temp.workspace,
                userConfigDir: temp.userConfig,
                maxFileBytes: 1024,
            });

            expect(overrides).toEqual({});
            expect(diagnostics.some((d) => d.message.toLowerCase().includes('size'))).toBe(true);
        });
    });

    describe('cache invalidation (stale_state guard)', () => {
        it('returns a different result when the resolved source path changes', () => {
            // Workspace A: .mctrl override present.
            const workspaceA = mkdtempSync(join(tmpdir(), 'mctrl-keybind-cfg-a-'));
            mkdirSync(join(workspaceA, '.mctrl'), { recursive: true });
            writeFileSync(join(workspaceA, '.mctrl', KEYBIND_CONFIG_FILENAME), '{"model_cycle":"f2"}', 'utf8');

            // Workspace B: no config file.
            const workspaceB = mkdtempSync(join(tmpdir(), 'mctrl-keybind-cfg-b-'));

            clearKeybindConfigCache();
            const a = resolveKeybindConfig({ workspaceRoot: workspaceA, userConfigDir: temp.userConfig });
            const b = resolveKeybindConfig({ workspaceRoot: workspaceB, userConfigDir: temp.userConfig });

            expect(a.keybinds.model_cycle).toBe('f2');
            expect(b.keybinds.model_cycle).toBe('ctrl+p');
        });

        it('picks up a file edit when the mtime changes', () => {
            const target = writeKeybinds(temp.workspace, ['.mctrl', KEYBIND_CONFIG_FILENAME], '{"model_cycle":"f2"}');

            const first = resolveKeybindConfig({ workspaceRoot: temp.workspace, userConfigDir: temp.userConfig });
            expect(first.keybinds.model_cycle).toBe('f2');

            // Rewrite the file (new mtime) and clear the clock so the cache
            // re-stats.
            clearKeybindConfigCache();
            writeFileSync(target, '{"model_cycle":"f4"}', 'utf8');

            const second = resolveKeybindConfig({ workspaceRoot: temp.workspace, userConfigDir: temp.userConfig });
            expect(second.keybinds.model_cycle).toBe('f4');
        });
    });
});
