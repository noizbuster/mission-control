import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createMissionControlLibConfig } from '../../tooling/vite/create-mission-control-lib-config.ts';

const entry = {
    index: fileURLToPath(new URL('./src/index.tsx', import.meta.url)),
    args: fileURLToPath(new URL('./src/args.ts', import.meta.url)),
    'commands/run-agent': fileURLToPath(new URL('./src/commands/run-agent.ts', import.meta.url)),
    'commands/session': fileURLToPath(new URL('./src/commands/session.ts', import.meta.url)),
    'commands/mission-control-services': fileURLToPath(
        new URL('./src/commands/mission-control-services.ts', import.meta.url),
    ),
};

// Multi-entry lib mode keeps dynamic TUI / interactive imports as separate chunks
// (inlineDynamicImports cannot be true with multiple entries).
export default defineConfig(
    createMissionControlLibConfig({
        entry,
        externalPackages: [
            '@mission-control/config',
            '@mission-control/core',
            '@mission-control/protocol',
            '@mission-control/tui',
        ],
        bannerEntryFileNames: ['index.js'],
    }),
);
