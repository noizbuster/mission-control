import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            '@mission-control/config': new URL('./packages/config/src/index.ts', import.meta.url).pathname,
            '@mission-control/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
            '@mission-control/protocol': new URL('./packages/protocol/src/index.ts', import.meta.url).pathname,
        },
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
