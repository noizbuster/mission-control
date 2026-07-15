import { describe, expect, it } from 'vitest';
import {
    createEntryShebangBanner,
    createExternalDependencyPredicate,
    createMissionControlLibConfig,
    MISSION_CONTROL_FFI_SHEBANG,
} from './create-mission-control-lib-config.ts';

const externalPackages = [
    '@mission-control/core',
    'zod',
] as const;

describe('createExternalDependencyPredicate', () => {
    it('marks node builtins, exact packages, and package subpaths as external', () => {
        // Given
        const isExternal = createExternalDependencyPredicate(externalPackages);

        // When / Then
        expect(isExternal('node:fs')).toBe(true);
        expect(isExternal('node:path')).toBe(true);
        expect(isExternal('@mission-control/core')).toBe(true);
        expect(isExternal('@mission-control/core/replay')).toBe(true);
        expect(isExternal('zod')).toBe(true);
        expect(isExternal('zod/v4')).toBe(true);
    });

    it('does not mark relative or absolute paths as external', () => {
        // Given
        const isExternal = createExternalDependencyPredicate(externalPackages);

        // When / Then
        expect(isExternal('./local-module.ts')).toBe(false);
        expect(isExternal('../sibling/module.ts')).toBe(false);
        expect(isExternal('/abs/path/to/module.ts')).toBe(false);
        expect(isExternal('@mission-control/other')).toBe(false);
        expect(isExternal('zodiac')).toBe(false);
    });
});

describe('createEntryShebangBanner', () => {
    it('prepends the exact FFI shebang only for listed entry file names', () => {
        // Given
        const banner = createEntryShebangBanner(['index.js']);

        // When
        const entryBanner = banner({ fileName: 'index.js' });
        const chunkBanner = banner({ fileName: 'chunks/helper-abc123.js' });
        const otherEntryBanner = banner({ fileName: 'args.js' });

        // Then
        expect(entryBanner).toBe(MISSION_CONTROL_FFI_SHEBANG);
        expect(entryBanner).toBe('#!/usr/bin/env -S node --experimental-ffi\n');
        expect(
            Buffer.from(entryBanner, 'utf8').equals(
                Buffer.from('#!/usr/bin/env -S node --experimental-ffi\n', 'utf8'),
            ),
        ).toBe(true);
        expect(chunkBanner).toBe('');
        expect(otherEntryBanner).toBe('');
    });
});

describe('createMissionControlLibConfig', () => {
    it('wires the external predicate into rollupOptions', () => {
        // Given
        const config = createMissionControlLibConfig({
            entry: 'src/index.ts',
            externalPackages,
        });
        const external = config.build?.rollupOptions?.external;

        // When / Then
        expect(typeof external).toBe('function');
        if (typeof external !== 'function') {
            throw new Error('expected rollupOptions.external to be a function');
        }
        expect(external('node:fs', undefined, false)).toBe(true);
        expect(external('./local.ts', undefined, false)).toBe(false);
    });

    it('wires entry-only banner when bannerEntryFileNames is provided', () => {
        // Given
        const config = createMissionControlLibConfig({
            entry: { index: 'src/index.ts' },
            externalPackages,
            bannerEntryFileNames: ['index.js'],
        });
        const output = config.build?.rollupOptions?.output;
        if (output === undefined || Array.isArray(output)) {
            throw new Error('expected single rollup output options object');
        }

        // When / Then
        expect(typeof output.banner).toBe('function');
    });

    it('omits banner when bannerEntryFileNames is not provided', () => {
        // Given / When
        const config = createMissionControlLibConfig({
            entry: 'src/index.ts',
            externalPackages,
        });
        const output = config.build?.rollupOptions?.output;
        if (output === undefined || Array.isArray(output)) {
            throw new Error('expected single rollup output options object');
        }

        // Then
        expect(output.banner).toBeUndefined();
    });

    it('returns es-only lib build with fixed output names and sourcemaps', () => {
        // Given / When
        const config = createMissionControlLibConfig({
            entry: { index: 'src/index.ts', args: 'src/args.ts' },
            externalPackages,
            outDir: 'build-out',
        });

        // Then
        expect(config.build?.outDir).toBe('build-out');
        expect(config.build?.emptyOutDir).toBe(true);
        expect(config.build?.sourcemap).toBe(true);
        expect(config.build?.lib).toEqual({
            entry: { index: 'src/index.ts', args: 'src/args.ts' },
            formats: ['es'],
        });
        const output = config.build?.rollupOptions?.output;
        if (output === undefined || Array.isArray(output)) {
            throw new Error('expected single rollup output options object');
        }
        expect(output.entryFileNames).toBe('[name].js');
        expect(output.chunkFileNames).toBe('chunks/[name]-[hash].js');
        expect(config.plugins).toBeUndefined();
        expect(config.build?.lib).not.toHaveProperty('preserveModules');
    });
});
