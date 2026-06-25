#!/usr/bin/env node
// =============================================================================
// T18 deliverable (d): non-TUI module-graph gate.
//
// Proves deterministically that the keymap module graph is NOT loaded on the
// `--no-tui` path. The keymap provider (`apps/cli/src/platform/keymap/`) is
// reached ONLY via the opentui bridge's dynamic `await import(...)` (the TUI
// path). On `--no-tui` the bridge is never mounted, so the dynamic import
// never fires and the keymap + native-FFI keymap modules stay out of the graph.
//
// Mechanism: an ESM resolve hook (`tui-keymap-trace-hooks.mjs`, registered by
// `tui-keymap-trace-register.mjs`) tags every resolved module URL to stderr.
// This driver spawns the built CLI with `--no-tui` (the full non-TUI agent
// lifecycle: session/task/sidecar/stop), captures the tagged stderr, and
// asserts the forbidden modules are absent while a known non-TUI module IS
// present (sanity: the trace actually captured the graph).
//
// Exit status: 0 iff the gate holds; non-zero otherwise.
// =============================================================================
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CLI_DIST = resolve(REPO_ROOT, 'apps/cli/dist/index.js');
const PRELOAD = resolve(REPO_ROOT, 'scripts/tui-keymap-trace-register.mjs');

// Modules that MUST be absent from the --no-tui graph: every mctrl keymap
// PROVIDER + LAYER module, plus the FFI-bearing keymap backend. These are what
// "the keymap module graph is NOT loaded" means precisely — instantiating a
// keymap requires keymap-provider/keymap-instance, which in turn pulls
// `@opentui/keymap/opentui` (the native FFI backend). None of these load on
// --no-tui. Matched as substrings of the resolved file URL.
const FORBIDDEN = [
    // mctrl keymap provider + all registered layers (T3/T5/T7/T8/T9/T10/T11/T12/T13/T14/T15)
    'platform/keymap/keymap-provider',
    'platform/keymap/keymap-instance',
    'platform/keymap/command-palette',
    'platform/keymap/which-key-panel',
    'platform/keymap/messages-scroll',
    'platform/keymap/kill-ring',
    'platform/keymap/model-favorites',
    'platform/keymap/session-shortcuts',
    'platform/keymap/message-undo-redo',
    'platform/keymap/diff-viewer',
    'platform/keymap/leader-addons',
    'platform/keymap/leader-pending-cue',
    'platform/keymap/mode-stack',
    'platform/keymap/palette-open-context',
    'platform/keymap/keybind-config-loader',
    // The FFI backend (pulls native @opentui/core). NEVER on the --no-tui path.
    '@opentui/keymap/opentui',
    'keymap/src/opentui',
    '@opentui/keymap/testing',
];

// FFI-free keymap adapter modules that MAY appear transitively on --no-tui.
// `interactive-chat.ts` statically imports `createOpenTuiChatBridge` from the
// opentui bridge; the bridge statically imports `useKeymap` from
// `@opentui/keymap/react`. That adapter imports ONLY `react` + the
// `@opentui/keymap` core chunk (ZERO native FFI — verified in T3 learnings),
// so loading it does NOT instantiate a keymap and does NOT widen the FFI
// boundary. We detect + report it as INFO (not a gate failure) and document the
// root cause, rather than silently ignoring it.
const FFI_FREE_TRANSITIVE = ['@opentui/keymap/src/react', '@opentui/keymap/chunks'];

// A module that MUST be present (sanity: the trace captured the non-TUI graph).
const EXPECTED_PRESENT = ['commands/run-agent', 'interactive-chat'];

function runTraced(args) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, ['--experimental-ffi', '--import', PRELOAD, CLI_DIST, ...args], {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                MCTRL_DATA_DIR: resolve(REPO_ROOT, '.omo/evidence/tmp-nottui-trace'),
                // Force the non-TTY plain path; never the opentui bridge.
                MCTRL_FORCE_NO_TTY: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            resolvePromise({ code, stdout, stderr });
        });
    });
}

function extractGraph(stderr) {
    const lines = stderr.split('\n');
    const urls = [];
    for (const line of lines) {
        const marker = '[mctrl-graph] ';
        const idx = line.indexOf(marker);
        if (idx !== -1) {
            urls.push(line.slice(idx + marker.length).trim());
        }
    }
    return urls;
}

function report(label, ok, detail) {
    const tag = ok ? 'PASS' : 'FAIL';
    console.log(`[gate][${tag}] ${label}`);
    if (!ok && detail) {
        console.log(`         ${detail}`);
    }
    return ok;
}

async function main() {
    const args = ['--no-tui', '--provider', 'local', '--model', 'local-echo'];
    console.log('[gate] tracing --no-tui module graph...');
    const { code, stderr } = await runTraced(args);
    const graph = extractGraph(stderr);

    if (graph.length === 0) {
        report('loader trace captured the module graph', false, 'no [mctrl-graph] lines on stderr');
        console.log(`[gate] raw stderr tail:\n${stderr.split('\n').slice(-15).join('\n')}`);
        process.exit(1);
    }

    const allOk = [];

    // Sanity: the trace captured the non-TUI agent path.
    const presentHits = EXPECTED_PRESENT.filter((needle) => graph.some((url) => url.includes(needle)));
    allOk.push(
        report(
            `non-TUI agent path IS in the graph (sanity): ${presentHits.join(', ')}`,
            presentHits.length === EXPECTED_PRESENT.length,
            `expected ${EXPECTED_PRESENT.join(', ')}; got ${presentHits.join(', ') || '(none)'}`,
        ),
    );

    // The gate: forbidden keymap modules (provider + FFI backend) must be ABSENT.
    const violations = [];
    for (const forbidden of FORBIDDEN) {
        const hits = graph.filter((url) => url.includes(forbidden));
        if (hits.length > 0) {
            violations.push(`${forbidden} -> ${hits.join(',')}`);
        }
    }
    allOk.push(
        report(
            `keymap provider + FFI backend NOT loaded on --no-tui (${FORBIDDEN.length} critical modules absent)`,
            violations.length === 0,
            violations.length === 0
                ? undefined
                : `CRITICAL modules loaded:\n${violations.map((v) => `           ${v}`).join('\n')}`,
        ),
    );

    // INFO (not a gate failure): the FFI-free keymap react adapter may load
    // transitively via the bridge's static import. Report it honestly.
    const transitiveHits = [];
    for (const needle of FFI_FREE_TRANSITIVE) {
        const hits = graph.filter((url) => url.includes(needle));
        if (hits.length > 0) transitiveHits.push(`${needle} (${hits.length} module(s))`);
    }
    if (transitiveHits.length > 0) {
        console.log(
            `[gate][INFO] FFI-free keymap adapter loaded transitively on --no-tui: ${transitiveHits.join(', ')}`,
        );
        console.log('[gate][INFO]   root cause: interactive-chat.ts statically imports createOpenTuiChatBridge;');
        console.log('[gate][INFO]   the bridge statically imports useKeymap from @opentui/keymap/react.');
        console.log('[gate][INFO]   This is FFI-free (react + @opentui/keymap core only) and does NOT');
        console.log('[gate][INFO]   instantiate a keymap. Documented as a known minor finding (see');
        console.log('[gate][INFO]   .omo/notepads/tui-keymap-port/issues.md T18).');
    } else {
        console.log('[gate][PASS] no FFI-free keymap adapter loaded transitively');
    }

    console.log(`[gate] traced ${graph.length} modules; --no-tui exit code ${code}`);

    if (allOk.every(Boolean)) {
        console.log('[gate] NON-TUI KEYMAP-GRAPH GATE: PASS');
        process.exit(0);
    }
    console.log('[gate] NON-TUI KEYMAP-GRAPH GATE: FAIL');
    process.exit(1);
}

main().catch((err) => {
    console.error('[gate] driver crashed:', err);
    process.exit(1);
});
