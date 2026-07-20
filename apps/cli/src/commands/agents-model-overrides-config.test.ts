import { afterEach, describe, expect, it } from 'vitest';
import {
    clearOverride,
    type OverridesConfigOptions,
    parseModelPatternString,
    readModelPatternOverrides,
    readOverridesMap,
    resolveOverridesConfigPath,
    setOverride,
} from './agents-model-overrides-config';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function makeTempWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mc-overrides-'));
    tempDirs.push(dir);
    return dir;
}

function optionsFor(workspaceRoot: string): OverridesConfigOptions {
    return { workspaceRoot };
}

describe('resolveOverridesConfigPath', () => {
    it('defaults to <workspaceRoot>/.mctrl/agents.model-overrides.json', () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        // When
        const path = resolveOverridesConfigPath(optionsFor(workspaceRoot));
        // Then
        expect(path).toBe(join(workspaceRoot, '.mctrl', 'agents.model-overrides.json'));
    });

    it('honors an explicit overridesConfigPath override', () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        // When
        const path = resolveOverridesConfigPath({
            workspaceRoot,
            overridesConfigPath: '/custom/path.json',
        });
        // Then
        expect(path).toBe('/custom/path.json');
    });
});

describe('readOverridesMap', () => {
    it('returns an empty map when the file is missing', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        // When
        const map = await readOverridesMap(optionsFor(workspaceRoot));
        // Then
        expect(map).toBeInstanceOf(Map);
        expect(map.size).toBe(0);
    });

    it('returns an empty map and never throws on corrupt JSON', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        const path = resolveOverridesConfigPath(optionsFor(workspaceRoot));
        await writeGarbage(path, '{ not valid json');
        // When
        const map = await readOverridesMap(optionsFor(workspaceRoot));
        // Then
        expect(map.size).toBe(0);
    });

    it('returns an empty map when the parsed value is not an object', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        const path = resolveOverridesConfigPath(optionsFor(workspaceRoot));
        await writeGarbage(path, '["not", "an", "object"]');
        // When
        const map = await readOverridesMap(optionsFor(workspaceRoot));
        // Then
        expect(map.size).toBe(0);
    });

    it('returns an empty map when the parsed value is null', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        const path = resolveOverridesConfigPath(optionsFor(workspaceRoot));
        await writeGarbage(path, 'null');
        // When
        const map = await readOverridesMap(optionsFor(workspaceRoot));
        // Then
        expect(map.size).toBe(0);
    });

    it('filters out non-string override values, keeping valid ones', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        const path = resolveOverridesConfigPath(optionsFor(workspaceRoot));
        await writeGarbage(
            path,
            JSON.stringify({
                overrides: {
                    oracle: 'anthropic/claude-sonnet-4-6',
                    broken: 42,
                    alsoBroken: { nested: true },
                    keep: 'openai/gpt-5',
                },
                version: 1,
            }),
        );
        // When
        const map = await readOverridesMap(optionsFor(workspaceRoot));
        // Then
        expect([...map.entries()].sort()).toEqual([
            ['keep', 'openai/gpt-5'],
            ['oracle', 'anthropic/claude-sonnet-4-6'],
        ]);
    });

    it('reads overrides written by setOverride', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        await setOverride(optionsFor(workspaceRoot), 'oracle', 'anthropic/claude-sonnet-4-6');
        await setOverride(optionsFor(workspaceRoot), 'explore', 'openai/gpt-5#reasoning-high');
        // When
        const map = await readOverridesMap(optionsFor(workspaceRoot));
        // Then
        expect(map.get('oracle')).toBe('anthropic/claude-sonnet-4-6');
        expect(map.get('explore')).toBe('openai/gpt-5#reasoning-high');
    });
});

describe('setOverride', () => {
    it('writes {overrides:{name:value},version:1} to the config path', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        // When
        await setOverride(optionsFor(workspaceRoot), 'oracle', 'anthropic/claude-sonnet-4-6');
        // Then
        const raw = await readFile(resolveOverridesConfigPath(optionsFor(workspaceRoot)), 'utf8');
        expect(JSON.parse(raw)).toEqual({
            overrides: { oracle: 'anthropic/claude-sonnet-4-6' },
            version: 1,
        });
    });

    it('creates the .mctrl directory when it does not exist', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        // When
        await setOverride(optionsFor(workspaceRoot), 'oracle', 'anthropic/claude-sonnet-4-6');
        // Then
        expect(readdirSync(join(workspaceRoot, '.mctrl'))).toContain('agents.model-overrides.json');
    });

    it('preserves sibling overrides across writes', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        await setOverride(optionsFor(workspaceRoot), 'oracle', 'anthropic/claude-sonnet-4-6');
        // When
        await setOverride(optionsFor(workspaceRoot), 'explore', 'openai/gpt-5');
        // Then
        const map = await readOverridesMap(optionsFor(workspaceRoot));
        expect(map.get('oracle')).toBe('anthropic/claude-sonnet-4-6');
        expect(map.get('explore')).toBe('openai/gpt-5');
    });

    it('clears an override when value is undefined', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        await setOverride(optionsFor(workspaceRoot), 'oracle', 'anthropic/claude-sonnet-4-6');
        // When
        await setOverride(optionsFor(workspaceRoot), 'oracle', undefined);
        // Then
        const map = await readOverridesMap(optionsFor(workspaceRoot));
        expect(map.has('oracle')).toBe(false);
    });
});

describe('clearOverride', () => {
    it('removes a stored override and is a no-op when absent', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        await setOverride(optionsFor(workspaceRoot), 'oracle', 'anthropic/claude-sonnet-4-6');
        await setOverride(optionsFor(workspaceRoot), 'explore', 'openai/gpt-5');
        // When
        await clearOverride(optionsFor(workspaceRoot), 'oracle');
        await clearOverride(optionsFor(workspaceRoot), 'absent');
        // Then
        const map = await readOverridesMap(optionsFor(workspaceRoot));
        expect([...map.keys()]).toEqual(['explore']);
    });
});

describe('unknown-field passthrough', () => {
    it('survives a read-modify-write round-trip', async () => {
        // Given: a file authored with extra top-level fields
        const workspaceRoot = makeTempWorkspace();
        const path = resolveOverridesConfigPath(optionsFor(workspaceRoot));
        await writeGarbage(
            path,
            JSON.stringify({
                overrides: { oracle: 'anthropic/claude-sonnet-4-6' },
                version: 1,
                author: 'planner',
                schemaHint: 'experimental',
            }),
        );
        // When
        await setOverride(optionsFor(workspaceRoot), 'explore', 'openai/gpt-5');
        const raw = await readFile(path, 'utf8');
        // Then: unknown fields survive alongside the new override
        expect(JSON.parse(raw)).toEqual({
            overrides: {
                explore: 'openai/gpt-5',
                oracle: 'anthropic/claude-sonnet-4-6',
            },
            version: 1,
            author: 'planner',
            schemaHint: 'experimental',
        });
    });
});

describe('atomic writes', () => {
    it('leaves no stray .tmp files after a successful write', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        // When
        await setOverride(optionsFor(workspaceRoot), 'oracle', 'anthropic/claude-sonnet-4-6');
        // Then
        const entries = readdirSync(join(workspaceRoot, '.mctrl'));
        expect(entries).toEqual(['agents.model-overrides.json']);
        expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
    });
});

describe('parseModelPatternString', () => {
    it('parses provider/model', () => {
        expect(parseModelPatternString('anthropic/claude-sonnet-4-6')).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
        });
    });

    it('parses provider/model#variant', () => {
        expect(parseModelPatternString('openai/gpt-5#reasoning-high')).toEqual({
            providerID: 'openai',
            modelID: 'gpt-5',
            variantID: 'reasoning-high',
        });
    });

    it('parses a provider id containing dashes', () => {
        expect(parseModelPatternString('zai-coding-plan/glm-5.2')).toEqual({
            providerID: 'zai-coding-plan',
            modelID: 'glm-5.2',
        });
    });

    it('rejects a missing slash', () => {
        expect(parseModelPatternString('just-a-model')).toBeUndefined();
    });

    it('rejects an empty provider', () => {
        expect(parseModelPatternString('/gpt-5')).toBeUndefined();
    });

    it('rejects an empty model', () => {
        expect(parseModelPatternString('openai/')).toBeUndefined();
    });

    it('rejects a dangling variant separator', () => {
        expect(parseModelPatternString('openai/gpt-5#')).toBeUndefined();
        expect(parseModelPatternString('openai/#reasoning')).toBeUndefined();
    });
});

describe('readModelPatternOverrides', () => {
    it('parses stored strings into ModelPatterns and drops malformed entries', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        const path = resolveOverridesConfigPath(optionsFor(workspaceRoot));
        await writeGarbage(
            path,
            JSON.stringify({
                overrides: {
                    oracle: 'anthropic/claude-sonnet-4-6',
                    explore: 'openai/gpt-5#reasoning-high',
                    malformed: 'no-slash-here',
                },
                version: 1,
            }),
        );
        // When
        const patterns = await readModelPatternOverrides(optionsFor(workspaceRoot));
        // Then
        expect(patterns.get('oracle')).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
        expect(patterns.get('explore')).toEqual({
            providerID: 'openai',
            modelID: 'gpt-5',
            variantID: 'reasoning-high',
        });
        expect(patterns.has('malformed')).toBe(false);
    });

    it('returns an empty map when the config file is missing', async () => {
        // Given
        const workspaceRoot = makeTempWorkspace();
        // When
        const patterns = await readModelPatternOverrides(optionsFor(workspaceRoot));
        // Then
        expect(patterns.size).toBe(0);
    });
});

async function writeGarbage(path: string, contents: string): Promise<void> {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(path, '..'), { recursive: true });
    writeFileSync(path, contents, 'utf8');
}
