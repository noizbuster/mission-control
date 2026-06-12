import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: [
            {
                find: '@mission-control/core/replay',
                replacement: new URL('./packages/core/src/replay.ts', import.meta.url).pathname,
            },
            {
                find: '@mission-control/config',
                replacement: new URL('./packages/config/src/index.ts', import.meta.url).pathname,
            },
            {
                find: '@mission-control/core',
                replacement: new URL('./packages/core/src/index.ts', import.meta.url).pathname,
            },
            {
                find: '@mission-control/protocol',
                replacement: new URL('./packages/protocol/src/index.ts', import.meta.url).pathname,
            },
        ],
    },
    test: {
        include: [
            'tests/**/*.test.ts',
            'packages/**/*.test.ts',
            'apps/**/*.test.ts',
            'apps/**/*.test.tsx',
            'scripts/**/*.test.ts',
        ],
        globals: false,
    },
});
