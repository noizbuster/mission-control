import type { Plugin } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const coreTestShim = sourceEntry('./test-support/core-test-shim.ts');
const coreRedactionSource = sourceEntry('../../packages/core/src/redaction.ts');
const terminalTextSource = sourceEntry('./src/terminal-text.ts');
const tuiMainBarrel = '@mission-control/tui';
const tuiStateSourceSegment = '/apps/tui/src/state/';

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
    'platform/providers/index': sourceEntry('./src/platform/providers/index.tsx'),
    'components/StatusBar': sourceEntry('./src/components/StatusBar.tsx'),
    'components/AbgOverlay': sourceEntry('./src/components/AbgOverlay.tsx'),
    app: sourceEntry('./src/app.tsx'),
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

function isTuiStateMainBarrelImport(id: string, importer: string | undefined): boolean {
    const normalizedImporter = importer?.replaceAll('\\', '/');
    return id === tuiMainBarrel && normalizedImporter?.includes(tuiStateSourceSegment) === true;
}

function isExternalDependency(id: string, importer?: string): boolean {
    if (isTuiStateMainBarrelImport(id, importer)) return false;
    if (id.startsWith('node:')) return true;
    return externalPackages.some((packageName) => id === packageName || id.startsWith(`${packageName}/`));
}

function resolveTuiStateMainBarrelImports(): Plugin {
    return {
        name: 'resolve-tui-state-main-barrel-imports',
        enforce: 'pre',
        resolveId(source, importer) {
            if (isTuiStateMainBarrelImport(source, importer)) {
                return terminalTextSource;
            }
            return undefined;
        },
    };
}

// Node resolves bare `solid-js` to the SSR build (onMount no-op). Force client runtime.
function rewriteSolidJsNodeImports(): Plugin {
    const rewrite = (code: string): string =>
        code
            .replace(/(from\s+["'])solid-js\/store(["'])/g, '$1solid-js/store/dist/store.js$2')
            .replace(/(from\s+["'])solid-js(["'])/g, '$1solid-js/dist/solid.js$2')
            .replace(/(import\s*\(\s*["'])solid-js\/store(["']\s*\))/g, '$1solid-js/store/dist/store.js$2')
            .replace(/(import\s*\(\s*["'])solid-js(["']\s*\))/g, '$1solid-js/dist/solid.js$2');

    return {
        name: 'rewrite-solid-js-node-imports',
        enforce: 'post',
        generateBundle(_options, bundle) {
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== 'chunk') continue;
                chunk.code = rewrite(chunk.code);
            }
        },
    };
}

export default defineConfig(({ mode }) => ({
    plugins: [
        resolveTuiStateMainBarrelImports(),
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
        rewriteSolidJsNodeImports(),
    ],
    resolve:
        mode === 'test'
            ? {
                  alias: [
                      { find: '@mission-control/core/redaction', replacement: coreRedactionSource },
                      { find: '@mission-control/core', replacement: coreTestShim },
                  ],
              }
            : undefined,
    test: {
        environment: 'node',
        execArgv: ['--experimental-ffi'],
    },
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
