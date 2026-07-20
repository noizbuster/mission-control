import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeStartAutoCompaction } from './model-context-session';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('maybeStartAutoCompaction', () => {
    const roots: string[] = [];

    beforeEach(() => {
        vi.unstubAllEnvs();
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('returns undefined when auto-compact threshold is off', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-auto-compact-'));
        roots.push(dataDir);
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await mkdir(join(dataDir, 'tui'), { recursive: true });
        await writeFile(
            join(dataDir, 'tui', 'local-preferences.json'),
            JSON.stringify({
                version: 1,
                preferences: {
                    recentModels: [],
                    favoriteModels: [],
                    variantCyclingHints: [],
                    sessionPins: [],
                    uiToggles: [],
                    modelContextPrefs: [{ modelKey: 'openai/gpt-5', contextLimit: 100_000 }],
                },
            }),
            'utf8',
        );

        // When
        const turn = await maybeStartAutoCompaction({
            usedTokens: 95_000,
            selection: { providerID: 'openai', modelID: 'gpt-5' },
            sessionId: 'session_1',
            sessionStore: { compact: vi.fn() } as never,
            provider: {} as never,
            output: { write: vi.fn() },
        });

        // Then
        expect(turn).toBeUndefined();
    });

    it('starts compaction when usage crosses the stored threshold', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-auto-compact-on-'));
        roots.push(dataDir);
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await mkdir(join(dataDir, 'tui'), { recursive: true });
        await writeFile(
            join(dataDir, 'tui', 'local-preferences.json'),
            JSON.stringify({
                version: 1,
                preferences: {
                    recentModels: [],
                    favoriteModels: [],
                    variantCyclingHints: [],
                    sessionPins: [],
                    uiToggles: [],
                    modelContextPrefs: [
                        { modelKey: 'openai/gpt-5', contextLimit: 100_000, autoCompactThreshold: 0.8 },
                    ],
                },
            }),
            'utf8',
        );
        const write = vi.fn();

        // When
        const turn = await maybeStartAutoCompaction({
            usedTokens: 85_000,
            selection: { providerID: 'openai', modelID: 'gpt-5' },
            sessionId: 'session_1',
            sessionStore: { compact: vi.fn() } as never,
            provider: {} as never,
            output: { write },
        });

        // Then
        expect(turn).toBeDefined();
        expect(write).toHaveBeenCalledWith(expect.stringContaining('Auto-compacting'));
        turn?.interrupt();
        await turn?.done;
    });
});
