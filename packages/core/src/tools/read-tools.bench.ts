import { bench, describe } from 'vitest';
import { createNativesClient } from '../native/natives-client.js';
import { createWorkspaceGuard } from './read-tools-paths.js';
import { searchRepoText } from './read-tools-search.js';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const addonRoot = process.cwd();
const addonBuilt = existsSync(join(addonRoot, 'native', 'natives', 'index.node'));

const fileCount = 500;
const pattern = 'needle';

// Fixture: 500 small TypeScript-ish files, ~half containing the pattern.
async function buildFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-grep-bench-'));
    await mkdir(join(root, 'src'), { recursive: true });
    for (let i = 0; i < fileCount; i += 1) {
        const hasNeedle = i % 2 === 0;
        const line = hasNeedle ? `const needle${i} = ${i};` : `const value${i} = ${i};`;
        await writeFile(join(root, 'src', `f${String(i).padStart(3, '0')}.ts`), `${line}\nmore content\n`, 'utf8');
    }
    return root;
}

let workspaceRoot: string;
let guard: Awaited<ReturnType<typeof createWorkspaceGuard>>;
let natives: ReturnType<typeof createNativesClient>;
let files: string[];

describe.skipIf(!addonBuilt)('repo.search acceleration', () => {
    bench(
        'search via N-API (in-process Rust regex)',
        async () => {
            const result = await searchRepoText(
                guard,
                { pattern, path: 'src' },
                { maxMatches: 100, maxLineChars: 500 },
                natives,
            );
            if (result.matches.length === 0) {
                throw new Error('bench fixture produced no matches');
            }
        },
        { iterations: 20, warmupIterations: 5 },
    );

    bench(
        'search via TypeScript path (ripgrep when present)',
        async () => {
            const result = await searchRepoText(
                guard,
                { pattern, path: 'src' },
                { maxMatches: 100, maxLineChars: 500 },
            );
            if (result.matches.length === 0) {
                throw new Error('bench fixture produced no matches');
            }
        },
        { iterations: 20, warmupIterations: 5 },
    );

    // The pure-JS node fallback the N-API path replaces when ripgrep is
    // absent. Hand-rolled here to isolate the search-engine difference from
    // the directory walk, which both paths share.
    bench(
        'search via isolated node fallback (JS substring over contents)',
        async () => {
            let hits = 0;
            for (const file of files) {
                const bytes = await readFile(file);
                if (bytes.subarray(0, 4096).includes(0)) {
                    continue;
                }
                for (const line of bytes.toString('utf8').split(/\r?\n/)) {
                    if (line.includes(pattern)) {
                        hits += 1;
                    }
                }
            }
            if (hits === 0) {
                throw new Error('bench fixture produced no matches');
            }
        },
        { iterations: 20, warmupIterations: 5 },
    );
});

// Vitest does not provide a per-describe beforeAll for benches, so the fixture
// is prepared at module load and torn down when the process exits.
async function prepare(): Promise<void> {
    workspaceRoot = await buildFixture();
    guard = await createWorkspaceGuard(workspaceRoot);
    natives = createNativesClient({ onWarning: () => {} });
    const srcDir = join(workspaceRoot, 'src');
    const entries = await readdir(srcDir, { withFileTypes: true });
    files = entries.filter((entry) => entry.isFile()).map((entry) => join(srcDir, entry.name));
    files.sort((left, right) => left.localeCompare(right));
}

// Block module evaluation on fixture readiness so benches see populated state.
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
