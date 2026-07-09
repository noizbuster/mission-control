/**
 * Minimal OpenTUI resize probe — no Solid, no mission-control shell.
 *
 * If THIS blanks on horizontal expand, the bug is OpenTUI/native or the
 * terminal (not MC). OpenCode uses @opentui 0.3.4; MC uses 0.4.3.
 *
 *   bun scripts/opentui-resize-probe.mjs
 *   node --experimental-ffi scripts/opentui-resize-probe.mjs
 *
 * Ctrl+C exits. Red must always fill the entire window after any resize.
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmDir = join(repoRoot, 'node_modules/.pnpm');
const corePkgDirs = readdirSync(pnpmDir).filter((name) => name.startsWith('@opentui+core@'));
if (corePkgDirs.length === 0) {
    throw new Error('Could not find @opentui/core in node_modules/.pnpm');
}
// Prefer newest installed OpenTUI (MC targets 0.4.x; OpenCode catalog is 0.3.4).
const corePkgDir = corePkgDirs.sort().at(-1);
const coreEntry = join(pnpmDir, corePkgDir, 'node_modules/@opentui/core/index.js');
const { createCliRenderer, BoxRenderable, TextRenderable } = await import(pathToFileURL(coreEntry).href);

const runtime = typeof Bun !== 'undefined' ? 'bun' : 'node';

const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
    externalOutputMode: 'passthrough',
    autoFocus: false,
    openConsoleOnError: false,
});

const label = new TextRenderable(renderer, {
    content: `MINIMAL CORE PROBE  ${renderer.width}x${renderer.height}  (${runtime})`,
    fg: '#ffffff',
});

const hint = new TextRenderable(renderer, {
    content: 'horizontal + vertical resize must stay fully red',
    fg: '#ffffff',
});

const box = new BoxRenderable(renderer, {
    width: renderer.width,
    height: renderer.height,
    backgroundColor: '#ff0000',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
});

box.add(label);
box.add(hint);
renderer.root.add(box);

renderer.on('resize', (width, height) => {
    box.width = width;
    box.height = height;
    label.content = `MINIMAL CORE PROBE  ${width}x${height}  (${runtime})`;
    Reflect.set(renderer, 'forceFullRepaintRequested', true);
    renderer.requestRender();
});

process.stderr.write(
    `[resize-probe] started ${renderer.width}x${renderer.height} runtime=${runtime}\n`,
);
