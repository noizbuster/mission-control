import type { UserConfig } from 'vite';

export type MissionControlLibConfigOptions = {
    readonly entry: Record<string, string> | string;
    readonly externalPackages: readonly string[];
    readonly outDir?: string;
    readonly bannerEntryFileNames?: readonly string[];
};

/** Exact CLI entry shebang bytes (trailing newline required). */
export const MISSION_CONTROL_FFI_SHEBANG = '#!/usr/bin/env -S node --experimental-ffi\n';

export function createExternalDependencyPredicate(
    externalPackages: readonly string[],
): (id: string) => boolean {
    return (id: string): boolean => {
        if (id.startsWith('node:')) {
            return true;
        }
        return externalPackages.some(
            (packageName) => id === packageName || id.startsWith(`${packageName}/`),
        );
    };
}

export function createEntryShebangBanner(
    bannerEntryFileNames: readonly string[],
): (chunk: { readonly fileName: string }) => string {
    return (chunk: { readonly fileName: string }): string =>
        bannerEntryFileNames.includes(chunk.fileName) ? MISSION_CONTROL_FFI_SHEBANG : '';
}

/**
 * Shared Vite library-mode config for mission-control packages/apps.
 * No Solid/opentui plugins; no preserveModules; optional entry-only shebang banner.
 */
export function createMissionControlLibConfig(
    options: MissionControlLibConfigOptions,
): UserConfig {
    const outDir = options.outDir ?? 'dist';
    const isExternalDependency = createExternalDependencyPredicate(options.externalPackages);
    const bannerEntryFileNames = options.bannerEntryFileNames;

    const outputBase = {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
    } as const;

    const output =
        bannerEntryFileNames === undefined
            ? outputBase
            : {
                  ...outputBase,
                  banner: createEntryShebangBanner(bannerEntryFileNames),
              };

    return {
        build: {
            outDir,
            emptyOutDir: true,
            sourcemap: true,
            lib: {
                entry: options.entry,
                formats: ['es'],
            },
            rollupOptions: {
                external: isExternalDependency,
                output,
            },
        },
    };
}
