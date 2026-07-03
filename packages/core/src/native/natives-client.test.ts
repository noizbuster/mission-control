import { describe, expect, it } from 'vitest';
import { createNativesClient } from './natives-client.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const defaultAddonPath = join(root, 'native', 'natives', 'index.node');
// The native addon is an optional build artifact; CI may run without it. The
// happy-path tests assert real behavior when it is present and are skipped
// otherwise so the suite stays green in addon-less environments.
const addonBuilt = existsSync(defaultAddonPath);

describe('NativesClient', () => {
    it.skipIf(!addonBuilt)('returns a positive token count when the addon is loaded', () => {
        const client = createNativesClient();

        expect(client.available).toBe(true);
        const count = client.countTokens('hello world', 'gpt-4o');
        expect(count).not.toBeNull();
        expect(count).toBeGreaterThan(0);
    });

    it.skipIf(!addonBuilt)('returns 0 for empty input without crashing', () => {
        const client = createNativesClient({ onWarning: () => {} });

        expect(client.countTokens('', 'gpt-4o')).toBe(0);
    });

    it.skipIf(!addonBuilt)('defaults to o200k for an unknown model without crashing', () => {
        const client = createNativesClient({ onWarning: () => {} });

        const count = client.countTokens('hello world', 'totally-unknown-model');
        expect(count).not.toBeNull();
        expect(count).toBeGreaterThan(0);
    });

    it('returns null and emits a warning when the addon cannot be found', () => {
        const warnings: string[] = [];
        const client = createNativesClient({
            addonPath: '/nonexistent/mission-control-natives.node',
            onWarning: (message) => {
                warnings.push(message);
            },
        });

        expect(client.available).toBe(false);
        expect(client.countTokens('hello world', 'gpt-4o')).toBeNull();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('addon');
    });

    it('returns null and warns when the addon file exists but cannot be loaded', () => {
        const garbageDir = join(tmpdir(), 'mc-natives-test');
        const garbagePath = join(garbageDir, 'corrupt.node');
        mkdirSync(garbageDir, { recursive: true });
        writeFileSync(garbagePath, 'this is not a valid native addon');
        try {
            const warnings: string[] = [];
            const client = createNativesClient({
                addonPath: garbagePath,
                onWarning: (message) => {
                    warnings.push(message);
                },
            });

            expect(client.available).toBe(false);
            expect(client.countTokens('hello world', 'gpt-4o')).toBeNull();
            expect(warnings).toHaveLength(1);
        } finally {
            rmSync(garbageDir, { recursive: true, force: true });
        }
    });

    it('does not emit the load warning more than once per client', () => {
        const warnings: string[] = [];
        const client = createNativesClient({
            addonPath: '/nonexistent/mission-control-natives.node',
            onWarning: (message) => {
                warnings.push(message);
            },
        });

        client.countTokens('a', 'gpt-4o');
        client.countTokens('b', 'gpt-4o');
        client.countTokens('c', 'gpt-4o');

        expect(warnings).toHaveLength(1);
    });
});
