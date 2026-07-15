import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createMissionControlLibConfig } from '../../tooling/vite/create-mission-control-lib-config.ts';

const entry = {
    index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    replay: fileURLToPath(new URL('./src/replay.ts', import.meta.url)),
    redaction: fileURLToPath(new URL('./src/redaction.ts', import.meta.url)),
};

export default defineConfig(
    createMissionControlLibConfig({
        entry,
        externalPackages: [
            '@mission-control/config',
            '@mission-control/protocol',
            '@libsql/client',
            'drizzle-orm',
            'ai',
            '@ai-sdk/anthropic',
            '@ai-sdk/google',
            '@ai-sdk/openai',
            '@ai-sdk/provider',
            '@modelcontextprotocol/sdk',
            'diff',
            'puppeteer-core',
            'yaml',
            'zod',
        ],
    }),
);
