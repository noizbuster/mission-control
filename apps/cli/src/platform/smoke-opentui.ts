// Smoke test: verify @opentui/core's createCliRenderer() boots on Node 26.3+ via
// the native node:ffi backend. Exercises every layer the runtime uses: native .so
// dlopen through node:ffi, native callbacks (log/event sink), and bun-ffi-structs
// struct packing through node:ffi's ptr()/toArrayBuffer() (StyledChunkStruct.packList
// is on the text render path).
//
// Run inside a real PTY so the renderer has a TTY to draw to:
//   node --experimental-strip-types apps/cli/src/platform/smoke-opentui.ts
//
// Success = the renderer is created, the text is rendered, the process exits 0.

import { createCliRenderer, TextRenderable } from '@opentui/core';

const RENDER_TEXT = 'Hello from opentui+node:ffi!';
const RENDER_MS = 500;

async function main(): Promise<void> {
    const renderer = await createCliRenderer({ exitOnCtrlC: false });

    const text = new TextRenderable(renderer, {
        id: 'smoke-text',
        content: RENDER_TEXT,
    });
    renderer.root.add(text);

    // Let at least one native render frame flush the text to the terminal.
    await new Promise((resolve) => setTimeout(resolve, RENDER_MS));

    // Explicit success marker on stderr (stdout is owned by the rendered screen).
    process.stderr.write('SMOKE OK: renderer created + rendered via node:ffi\n');

    renderer.destroy();
    process.exit(0);
}

main().catch((err: unknown) => {
    console.error('SMOKE TEST FAILED:', err);
    process.exit(1);
});
