import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

const coreTestShim = sourceEntry('./test-support/core-test-shim.ts');

const entryPoints = {
    index: sourceEntry('./src/index.ts'),
    chat: sourceEntry('./src/chat.ts'),
    markdown: sourceEntry('./src/markdown.ts'),
    'state/index': sourceEntry('./src/state/index.ts'),
    'components/markdown/highlight': sourceEntry('./src/components/markdown/highlight.ts'),
    'components/markdown/theme': sourceEntry('./src/components/markdown/theme.ts'),
    'components/markdown/ansi-renderer': sourceEntry('./src/components/markdown/ansi-renderer.ts'),
    'components/markdown/ansi-theme': sourceEntry('./src/components/markdown/ansi-theme.ts'),
    'platform/keymap/keybind': sourceEntry('./src/platform/keymap/keybind.ts'),
    'platform/keymap/keybind-config-loader': sourceEntry('./src/platform/keymap/keybind-config-loader.ts'),
    'platform/keymap/slash-mapping': sourceEntry('./src/platform/keymap/slash-mapping.ts'),
    'platform/opentui-renderer': sourceEntry('./src/platform/opentui-renderer.ts'),
    'platform/keymap/keymap-provider': sourceEntry('./src/platform/keymap/keymap-provider.tsx'),
    'platform/terminal-viewport-solid': sourceEntry('./src/platform/terminal-viewport-solid.ts'),
    'components/StatusBar': sourceEntry('./src/components/StatusBar.tsx'),
    'components/AbgOverlay': sourceEntry('./src/components/AbgOverlay.tsx'),
    'components/ChatApp': sourceEntry('./src/components/ChatApp.tsx'),
    'create-chat-tui': sourceEntry('./src/create-chat-tui.tsx'),
    'replay-overlay': sourceEntry('./src/replay-overlay.tsx'),
} satisfies Record<string, string>;

const externalPackages = [
    '@mission-control/config',
    '@mission-control/core',
    '@mission-control/protocol',
    '@mission-control/tui',
    '@opentui/core',
    '@opentui/keymap',
    '@opentui/solid',
    'solid-js',
    'diff',
    'marked',
    'remend',
    'web-tree-sitter',
    'wrap-ansi',
    '@dagrejs/dagre',
] as const;

function sourceEntry(relativePath: string): string {
    return fileURLToPath(new URL(relativePath, import.meta.url));
}

function resolveSolidNodeRuntime(sourcePath: string): string {
    if (sourcePath === 'solid-js') return 'solid-js/dist/solid.js';
    if (sourcePath === 'solid-js/store') return 'solid-js/store/dist/store.js';
    return sourcePath;
}

function isExternalDependency(id: string): boolean {
    if (id.startsWith('node:')) return true;
    return externalPackages.some((packageName) => id === packageName || id.startsWith(`${packageName}/`));
}

export default defineConfig(({ mode }) => ({
    plugins: [
        solidPlugin({
            solid: {
                moduleName: '@opentui/solid',
                generate: 'universal',
            },
            babel: {
                plugins: [
                    [
                        'module-resolver',
                        {
                            resolvePath: resolveSolidNodeRuntime,
                        },
                    ],
                ],
            },
        }),
    ],
    resolve: mode === 'test' ? { alias: { '@mission-control/core': coreTestShim } } : undefined,
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true,
        lib: {
            entry: entryPoints,
            formats: ['es'],
        },
        rollupOptions: {
            external: isExternalDependency,
            output: {
                entryFileNames: '[name].js',
                chunkFileNames: 'chunks/[name]-[hash].js',
                assetFileNames: 'assets/[name][extname]',
            },
        },
    },
}));
