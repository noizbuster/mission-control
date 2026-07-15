import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createMissionControlLibConfig } from '../../tooling/vite/create-mission-control-lib-config.ts';

const entry = {
    index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
};

export default defineConfig(
    createMissionControlLibConfig({
        entry,
        externalPackages: ['@mission-control/protocol'],
    }),
);
