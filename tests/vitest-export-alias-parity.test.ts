import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('vitest export alias parity', () => {
    it('covers formal core/config/cli package export keys with vitest aliases', () => {
        // Given package.json export maps and the root vitest alias list
        const vitestConfig = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
        const packages: readonly { readonly name: string; readonly manifest: string }[] = [
            { name: '@mission-control/core', manifest: 'packages/core/package.json' },
            { name: '@mission-control/config', manifest: 'packages/config/package.json' },
            { name: '@mission-control/cli', manifest: 'apps/cli/package.json' },
        ];

        for (const entry of packages) {
            const manifest = JSON.parse(readFileSync(join(root, entry.manifest), 'utf8')) as {
                readonly exports?: Record<string, unknown>;
            };
            const exportKeys = Object.keys(manifest.exports ?? {});
            for (const exportKey of exportKeys) {
                // CLI main entry has top-level await; vitest aliases only multi-entry subpaths.
                if (entry.name === '@mission-control/cli' && exportKey === '.') continue;
                const aliasFind = exportKey === '.' ? entry.name : `${entry.name}${exportKey.slice(1)}`;
                // Then every formal export key has a matching vitest alias find string
                expect(vitestConfig).toContain(`find: '${aliasFind}'`);
            }
        }
    });
});
