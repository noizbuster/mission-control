import { bench, describe } from 'vitest';
import { createNativesClient } from '../native/natives-client';
import { createGlobToolRegistration } from './glob-tool-factory';
import { createWorkspaceGuard, defaultReadOnlyRepoToolDenylist } from './read-tools-paths';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const addonRoot = process.cwd();
const addonBuilt = existsSync(join(addonRoot, 'native', 'natives', 'index.node'));

const fileCount = 500;

async function buildFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-glob-bench-'));
    await mkdir(join(root, 'src'), { recursive: true });
    for (let i = 0; i < fileCount; i += 1) {
        const ext = i % 3 === 0 ? '.ts' : i % 3 === 1 ? '.json' : '.md';
        await writeFile(join(root, 'src', `f${String(i).padStart(3, '0')}${ext}`), `content ${i}\n`, 'utf8');
    }
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    for (let i = 0; i < 50; i += 1) {
        await writeFile(join(root, 'src', 'nested', `deep${i}.ts`), `deep ${i}\n`, 'utf8');
    }
    return root;
}

let workspaceRoot: string;
let tsRegistration: Awaited<ReturnType<typeof createGlobToolRegistration>>;
let napiRegistration: Awaited<ReturnType<typeof createGlobToolRegistration>>;
let natives: ReturnType<typeof createNativesClient>;
let guard: Awaited<ReturnType<typeof createWorkspaceGuard>>;

describe.skipIf(!addonBuilt)('glob acceleration', () => {
    bench(
        'glob via N-API (in-process Rust ignore walker)',
        async () => {
            const result = await napiRegistration.execute(
                { pattern: '**/*.ts' },
                { toolCallId: 'bench_napi', toolName: 'glob', signal: AbortSignal.abort() },
            );
            if (result.paths.length === 0) {
                throw new Error('bench fixture produced no matches');
            }
        },
        { iterations: 20, warmupIterations: 5 },
    );

    bench(
        'glob via TypeScript path (recursive readdir + regex)',
        async () => {
            const result = await tsRegistration.execute(
                { pattern: '**/*.ts' },
                { toolCallId: 'bench_ts', toolName: 'glob', signal: AbortSignal.abort() },
            );
            if (result.paths.length === 0) {
                throw new Error('bench fixture produced no matches');
            }
        },
        { iterations: 20, warmupIterations: 5 },
    );
});

async function prepare(): Promise<void> {
    workspaceRoot = await buildFixture();
    guard = await createWorkspaceGuard(workspaceRoot);
    natives = createNativesClient({ onWarning: () => {} });
    tsRegistration = await createGlobToolRegistration({ workspaceRoot: workspaceRoot });
    napiRegistration = await createGlobToolRegistration({
        workspaceRoot: workspaceRoot,
        natives,
    });
}

await prepare();

process.on('exit', () => {
    if (workspaceRoot !== undefined) {
        try {
            rmSync(workspaceRoot, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup; temp dir is disposable.
        }
    }
});
