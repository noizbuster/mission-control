import { describe, expect, it } from 'vitest';
import {
    copyDir,
    createIsoClient,
    type IsoResolution,
    resolveViaFallback,
    type SidecarIsoInvoker,
    type SidecarResolvePayload,
} from './iso-client';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeSourceTree(): Promise<string> {
    const root = await mkdtempFallback();
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'keep.txt'), 'alpha\n');
    await writeFile(join(root, 'nested', 'deep.txt'), 'deep-alpha\n');
    return root;
}

function mkdtempFallback(): Promise<string> {
    return import('node:fs/promises').then((mod) => mod.mkdtemp(join(tmpdir(), 'mctrl-iso-test-')));
}

function invokerReturning(payload: SidecarResolvePayload): SidecarIsoInvoker {
    return {
        async resolve() {
            return payload;
        },
        async diff() {
            return { diff: '', identical: true };
        },
    };
}

function invokerThatThrows(): SidecarIsoInvoker {
    return {
        async resolve() {
            throw new Error('sidecar explosion');
        },
        async diff() {
            throw new Error('sidecar explosion');
        },
    };
}

describe('iso-client fallback (unsupported)', () => {
    it('falls back to in-process rcopy when the sidecar reports unsupported', async () => {
        const source = await makeSourceTree();
        try {
            const client = createIsoClient({
                invoker: invokerReturning({ resolved: '', method: 'unsupported' }),
            });
            const resolution = await client.resolve(source);

            expect(resolution.method).toBe('rcopy-fallback');
            expect(resolution.failed).toBe(false);
            expect(resolution.resolved.length).toBeGreaterThan(0);
            expect(existsSync(join(resolution.resolved, 'keep.txt'))).toBe(true);
            expect(existsSync(join(resolution.resolved, 'nested', 'deep.txt'))).toBe(true);
        } finally {
            await rm(source, { recursive: true, force: true });
        }
    });

    it('falls back when the sidecar returns an empty resolved path', async () => {
        const source = await makeSourceTree();
        try {
            const client = createIsoClient({
                invoker: invokerReturning({ resolved: '' }),
            });
            const resolution = await client.resolve(source);

            expect(resolution.method).toBe('rcopy-fallback');
            expect(resolution.failed).toBe(false);
        } finally {
            await rm(source, { recursive: true, force: true });
        }
    });

    it('falls back when the sidecar invocation throws', async () => {
        const source = await makeSourceTree();
        try {
            const client = createIsoClient({ invoker: invokerThatThrows() });
            const resolution = await client.resolve(source);

            expect(resolution.method).toBe('rcopy-fallback');
            expect(resolution.failed).toBe(false);
            expect(existsSync(resolution.resolved)).toBe(true);
        } finally {
            await rm(source, { recursive: true, force: true });
        }
    });
});

describe('iso-client success path', () => {
    it('uses the sidecar resolved path when a supported method is returned', async () => {
        const source = await makeSourceTree();
        try {
            const sidecarResolved = join(source, '.mock-merged');
            await mkdir(sidecarResolved, { recursive: true });
            const client = createIsoClient({
                invoker: invokerReturning({ resolved: sidecarResolved, method: 'overlayfs' }),
            });
            const resolution: IsoResolution = await client.resolve(source);

            expect(resolution.method).toBe('overlayfs');
            expect(resolution.failed).toBe(false);
            expect(resolution.resolved).toBe(sidecarResolved);
        } finally {
            await rm(source, { recursive: true, force: true });
        }
    });

    it('normalises an undefined method to rcopy', async () => {
        const source = await makeSourceTree();
        try {
            const client = createIsoClient({
                invoker: invokerReturning({ resolved: join(source, 'merged-x') }),
            });
            const resolution = await client.resolve(source);

            expect(resolution.method).toBe('rcopy');
            expect(resolution.resolved).toBe(join(source, 'merged-x'));
        } finally {
            await rm(source, { recursive: true, force: true });
        }
    });

    it('treats a failed: method as unsupported and falls back', async () => {
        const source = await makeSourceTree();
        try {
            const client = createIsoClient({
                invoker: invokerReturning({ resolved: '', method: 'failed:disk full' }),
            });
            const resolution = await client.resolve(source);

            expect(resolution.method).toBe('rcopy-fallback');
            expect(resolution.failed).toBe(false);
        } finally {
            await rm(source, { recursive: true, force: true });
        }
    });
});

describe('iso-client worktree independence (adversarial)', () => {
    it('writes inside the fallback worktree do not leak into the source', async () => {
        const source = await makeSourceTree();
        let merged = '';
        try {
            const resolution = await resolveViaFallback(source);
            expect(resolution.failed).toBe(false);
            merged = resolution.resolved;

            await writeFile(join(merged, 'only-in-worktree.txt'), 'worktree-only\n');
            await writeFile(join(merged, 'keep.txt'), 'mutated\n');

            expect(existsSync(join(source, 'only-in-worktree.txt'))).toBe(false);
            const sourceKeep = await import('node:fs/promises').then((mod) =>
                mod.readFile(join(source, 'keep.txt'), 'utf8'),
            );
            expect(sourceKeep).toBe('alpha\n');
        } finally {
            await rm(source, { recursive: true, force: true });
            if (merged.length > 0) {
                await rm(merged, { recursive: true, force: true });
            }
        }
    });

    it('copyDir produces a deep mirror that is independent of the source', async () => {
        const source = await makeSourceTree();
        const dst = await mkdtempFallback();
        try {
            await copyDir(source, dst);
            expect(existsSync(join(dst, 'nested', 'deep.txt'))).toBe(true);

            await writeFile(join(dst, 'new.txt'), 'x\n');
            await rm(join(dst, 'keep.txt'), { force: true });

            expect(existsSync(join(source, 'new.txt'))).toBe(false);
            expect(existsSync(join(source, 'keep.txt'))).toBe(true);
        } finally {
            await rm(source, { recursive: true, force: true });
            await rm(dst, { recursive: true, force: true });
        }
    });
});

describe('iso-client diff', () => {
    it('passes through the sidecar diff payload', async () => {
        const client = createIsoClient({
            invoker: {
                async resolve() {
                    return { resolved: '/x', method: 'rcopy' };
                },
                async diff() {
                    return { diff: '-a\n+b', identical: false };
                },
            },
        });
        const outcome = await client.diff('/baseline', '/current');
        expect(outcome.diff).toBe('-a\n+b');
        expect(outcome.identical).toBe(false);
    });

    it('surfaces sidecar diff failures as rejections (no in-process fallback)', async () => {
        const client = createIsoClient({ invoker: invokerThatThrows() });
        await expect(client.diff('/baseline', '/current')).rejects.toThrow();
    });
});

describe('iso-client missing source', () => {
    it('reports a failed fallback resolution when the source does not exist', async () => {
        const resolution = await resolveViaFallback('/nonexistent/mctrl-iso-missing-source');
        expect(resolution.failed).toBe(true);
        expect(resolution.resolved).toBe('');
    });
});
