import { defineConfig } from 'vitest/config';

const tuiSrc = new URL('./apps/tui/src/', import.meta.url).pathname;

export default defineConfig({
    resolve: {
        alias: [
            {
                find: '@mission-control/core/replay',
                replacement: new URL('./packages/core/src/replay.ts', import.meta.url).pathname,
            },
            {
                find: '@mission-control/core/redaction',
                replacement: new URL('./packages/core/src/redaction.ts', import.meta.url).pathname,
            },
            {
                find: '@mission-control/config',
                replacement: new URL('./packages/config/src/index.ts', import.meta.url).pathname,
            },
            {
                find: '@mission-control/core',
                replacement: new URL('./packages/core/src/index.ts', import.meta.url).pathname,
            },
            // TUI subpath aliases — MUST precede the generic '@mission-control/tui' entry
            // so prefix matching resolves to the correct source file.
            { find: '@mission-control/tui/chat', replacement: `${tuiSrc}chat.ts` },
            { find: '@mission-control/tui/markdown', replacement: `${tuiSrc}markdown.ts` },
            { find: '@mission-control/tui/state', replacement: `${tuiSrc}state/index.ts` },
            { find: '@mission-control/tui/highlight', replacement: `${tuiSrc}components/markdown/highlight.ts` },
            { find: '@mission-control/tui/markdown-theme', replacement: `${tuiSrc}components/markdown/theme.ts` },
            { find: '@mission-control/tui/ansi-renderer', replacement: `${tuiSrc}components/markdown/ansi-renderer.ts` },
            { find: '@mission-control/tui/ansi-theme', replacement: `${tuiSrc}components/markdown/ansi-theme.ts` },
            { find: '@mission-control/tui/keybind', replacement: `${tuiSrc}platform/keymap/keybind.ts` },
            {
                find: '@mission-control/tui/keybind-config',
                replacement: `${tuiSrc}platform/keymap/keybind-config-loader.ts`,
            },
            { find: '@mission-control/tui/slash-mapping', replacement: `${tuiSrc}platform/keymap/slash-mapping.ts` },
            { find: '@mission-control/tui/opentui-renderer', replacement: `${tuiSrc}platform/opentui-renderer.ts` },
            { find: '@mission-control/tui/keymap-provider', replacement: `${tuiSrc}platform/keymap/keymap-provider.tsx` },
            {
                find: '@mission-control/tui/terminal-viewport-react',
                replacement: `${tuiSrc}platform/terminal-viewport-react.ts`,
            },
            { find: '@mission-control/tui/status-bar', replacement: `${tuiSrc}components/StatusBar.tsx` },
            { find: '@mission-control/tui/abg-overlay', replacement: `${tuiSrc}components/AbgOverlay.tsx` },
            { find: '@mission-control/tui/chat-app', replacement: `${tuiSrc}components/ChatApp.tsx` },
            { find: '@mission-control/tui/create-chat-tui', replacement: `${tuiSrc}create-chat-tui.tsx` },
            { find: '@mission-control/tui/replay-overlay', replacement: `${tuiSrc}replay-overlay.tsx` },
            { find: '@mission-control/tui', replacement: `${tuiSrc}index.ts` },
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
