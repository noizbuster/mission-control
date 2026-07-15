import { isInternalSchemeInput, parseInternalSchemeUrl } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
    type AgentOutputEntry,
    type ConflictChoice,
    createSchemeResolver,
    extractJsonPath,
    type GithubSchemeBackend,
    InMemoryAgentOutputStore,
    InMemoryConflictStore,
    interceptRead,
    interceptWrite,
    parseConflictBlocks,
    pathnameToPath,
    type SchemeResolveContext,
} from './scheme-resolver';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'scheme-resolver-'));
    tempRoots.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
    tempRoots.length = 0;
});

describe('protocol: parseInternalSchemeUrl + isInternalSchemeInput', () => {
    it('parses scheme://host preserving host casing', () => {
        const parsed = parseInternalSchemeUrl('skill://My-Skill');
        expect(parsed.scheme).toBe('skill');
        expect(parsed.rawHost).toBe('My-Skill');
        expect(parsed.pathname).toBe('');
    });

    it('parses namespaced hosts with a colon (skill://plugin:name)', () => {
        const parsed = parseInternalSchemeUrl('skill://plugin:name');
        expect(parsed.scheme).toBe('skill');
        expect(parsed.rawHost).toBe('plugin:name');
    });

    it('parses scheme://host/path/segments and query', () => {
        const parsed = parseInternalSchemeUrl('pr://owner/repo/123?comments=0');
        expect(parsed.rawHost).toBe('owner');
        expect(parsed.pathname).toBe('/repo/123');
        expect(parsed.searchParams.get('comments')).toBe('0');
    });

    it('isInternalSchemeInput flags registered schemes only', () => {
        expect(isInternalSchemeInput('pr://123')).toBe(true);
        expect(isInternalSchemeInput('agent://x')).toBe(true);
        expect(isInternalSchemeInput('conflict://1')).toBe(true);
        expect(isInternalSchemeInput('https://example.com')).toBe(false);
        expect(isInternalSchemeInput('src/foo.ts')).toBe(false);
        expect(isInternalSchemeInput('ftp://x')).toBe(false);
    });

    it('throws on non-scheme input', () => {
        expect(() => parseInternalSchemeUrl('not-a-url')).toThrow();
    });
});

describe('json path extraction (agent:// helper)', () => {
    it('walks dotted paths into arrays and objects', () => {
        const data = { findings: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] };
        expect(extractJsonPath(data, 'findings.0.path')).toBe('src/a.ts');
        expect(extractJsonPath(data, 'findings.1.path')).toBe('src/b.ts');
    });

    it('returns undefined for missing segments', () => {
        expect(extractJsonPath({ a: 1 }, 'b.c')).toBeUndefined();
    });

    it('pathnameToQuery converts /foo/0/bar', () => {
        expect(pathnameToPath('/foo/0/bar')).toBe('foo.0.bar');
        expect(pathnameToPath('/')).toBe('');
    });
});

describe('conflict marker parsing', () => {
    it('parses a single ours/theirs block', () => {
        const content = 'line1\n<<<<<<< HEAD\nours-line\n=======\ntheirs-line\n>>>>>>> branch\nlineN\n';
        const blocks = parseConflictBlocks(content);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.ours).toBe('ours-line');
        expect(blocks[0]?.theirs).toBe('theirs-line');
    });

    it('parses multiple blocks', () => {
        const content = '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\nmid\n<<<<<<< c\np\n=======\nq\n>>>>>>> d\n';
        const blocks = parseConflictBlocks(content);
        expect(blocks).toHaveLength(2);
    });
});

describe('SchemeResolver: pr:// and issue:// via github backend', () => {
    function githubBackend(records: Record<string, string>): GithubSchemeBackend & { calls: string[][] } {
        const calls: string[][] = [];
        return {
            calls,
            async runGhJson(args: readonly string[], _context: SchemeResolveContext): Promise<string> {
                const argv = [...args];
                calls.push(argv);
                const op = argv.slice(0, 3).join(' ');
                const record = records[op] ?? records[argv.join(' ')];
                if (record === undefined) {
                    throw new Error(`unexpected gh argv: ${argv.join(' ')}`);
                }
                return record;
            },
        };
    }

    it('resolves pr://N via gh pr view, short form (repo derived by gh)', async () => {
        const backend = githubBackend({
            'pr view 1063': JSON.stringify({
                number: 1063,
                title: 'Add scheme resolver',
                state: 'OPEN',
                author: { login: 'alice' },
                body: 'PR body text',
                url: 'https://github.com/o/r/pull/1063',
            }),
        });
        const resolver = createSchemeResolver({ github: backend });
        const resource = await resolver.resolve('pr://1063');
        const argv = backend.calls[0];
        expect(argv?.slice(0, 4)).toEqual(['pr', 'view', '1063', '--json']);
        const fieldsArg = argv?.[argv.length - 1] ?? '';
        expect(fieldsArg).toContain('reviews');
        expect(fieldsArg).toContain('title');
        expect(resource.contentType).toBe('text/markdown');
        expect(resource.content).toContain('PR #1063');
        expect(resource.content).toContain('Add scheme resolver');
        expect(resource.content).toContain('alice');
        expect(resource.content).toContain('PR body text');
        expect(resource.immutable).toBe(true);
    });

    it('resolves pr://owner/repo/123 and forwards --repo', async () => {
        const backend = githubBackend({
            'pr view 123': JSON.stringify({ number: 123, title: 't', state: 'OPEN', body: 'b' }),
        });
        const resolver = createSchemeResolver({ github: backend });
        await resolver.resolve('pr://owner/repo/123');
        expect(backend.calls[0]).toContain('--repo');
        expect(backend.calls[0]).toContain('owner/repo');
        expect(backend.calls[0]?.[0]).toBe('pr');
    });

    it('suppresses comments with ?comments=0', async () => {
        const backend = githubBackend({
            'pr view 5': JSON.stringify({ number: 5, title: 't', state: 'OPEN', body: 'b' }),
        });
        const resolver = createSchemeResolver({ github: backend });
        await resolver.resolve('pr://5?comments=0');
        const fieldsArg = backend.calls[0]?.[backend.calls[0]?.length - 1] ?? '';
        expect(fieldsArg).not.toContain('reviews');
    });

    it('resolves issue://N via gh issue view', async () => {
        const backend = githubBackend({
            'issue view 42': JSON.stringify({
                number: 42,
                title: 'Bug',
                state: 'closed',
                stateReason: 'completed',
                author: { login: 'bob' },
                body: 'issue body',
            }),
        });
        const resolver = createSchemeResolver({ github: backend });
        const resource = await resolver.resolve('issue://42');
        expect(backend.calls[0]?.[1]).toBe('view');
        expect(backend.calls[0]?.[0]).toBe('issue');
        expect(resource.content).toContain('ISSUE #42');
        expect(resource.content).toContain('Bug');
    });

    it('rejects an invalid pr number', async () => {
        const resolver = createSchemeResolver({ github: githubBackend({}) });
        await expect(resolver.resolve('pr://notanumber')).rejects.toThrow(/Invalid pr:\/\/ number/);
    });

    it('surfaces non-JSON gh output as text/plain', async () => {
        const backend = githubBackend({ 'pr view 9': 'not-json' });
        const resolver = createSchemeResolver({ github: backend });
        const resource = await resolver.resolve('pr://9');
        expect(resource.contentType).toBe('text/plain');
        expect(resource.content).toBe('not-json');
    });
});

describe('SchemeResolver: agent:// via AgentOutputStore', () => {
    it('resolves full agent output content', async () => {
        const store = new InMemoryAgentOutputStore();
        store.register({ id: 'reviewer_0', content: '# Review\nall good' });
        const resolver = createSchemeResolver({ agentOutputs: store });
        const resource = await resolver.resolve('agent://reviewer_0');
        expect(resource.content).toBe('# Review\nall good');
        expect(resource.contentType).toBe('text/markdown');
    });

    it('extracts a JSON field via path form agent://id/findings.0.path', async () => {
        const store = new InMemoryAgentOutputStore();
        store.register({
            id: 'exports',
            content: JSON.stringify({ findings: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }),
        });
        const resolver = createSchemeResolver({ agentOutputs: store });
        const resource = await resolver.resolve('agent://exports/findings.0.path');
        expect(resource.contentType).toBe('application/json');
        expect(JSON.parse(resource.content)).toBe('src/a.ts');
        expect(resource.notes).toContain('Extracted: findings.0.path');
    });

    it('extracts via ?q= query form', async () => {
        const store = new InMemoryAgentOutputStore();
        store.register({ id: 'x', content: JSON.stringify({ ok: true }) });
        const resolver = createSchemeResolver({ agentOutputs: store });
        const resource = await resolver.resolve('agent://x?q=ok');
        expect(JSON.parse(resource.content)).toBe(true);
    });

    it('rejects combining path and ?q=', async () => {
        const store = new InMemoryAgentOutputStore();
        store.register({ id: 'x', content: '{}' });
        const resolver = createSchemeResolver({ agentOutputs: store });
        await expect(resolver.resolve('agent://x/a?q=b')).rejects.toThrow(/cannot combine/);
    });

    it('lists available ids on miss', async () => {
        const store = new InMemoryAgentOutputStore();
        store.register({ id: 'a', content: 'x' });
        const resolver = createSchemeResolver({ agentOutputs: store });
        await expect(resolver.resolve('agent://missing')).rejects.toThrow(/Available: a/);
    });

    it('requires an id', async () => {
        const resolver = createSchemeResolver({ agentOutputs: new InMemoryAgentOutputStore() });
        await expect(resolver.resolve('agent://')).rejects.toThrow(/requires an output id/);
    });
});

describe('SchemeResolver: skill:// DELEGATES to the skill backend (no collapse)', () => {
    it('delegates to the injected SkillSchemeBackend and reads the file', async () => {
        const dir = await makeTempDir();
        const skillFile = join(dir, 'SKILL.md');
        await writeFile(skillFile, '# Skill body\n\ncontent here', 'utf8');
        let resolveCalls = 0;
        const backend = {
            resolveSkill(name: string) {
                resolveCalls += 1;
                if (name === 'my-skill') {
                    return { name, filePath: skillFile, baseDir: dir };
                }
                return undefined;
            },
            listNames() {
                return ['my-skill'];
            },
        };
        const resolver = createSchemeResolver({ skills: backend });
        const resource = await resolver.resolve('skill://my-skill');
        expect(resolveCalls).toBe(1);
        expect(resource.content).toContain('# Skill body');
        expect(resource.contentType).toBe('text/markdown');
        expect(resource.immutable).toBe(true);
    });

    it('reads a relative path under baseDir', async () => {
        const dir = await makeTempDir();
        await writeFile(join(dir, 'SKILL.md'), 'main', 'utf8');
        await writeFile(join(dir, 'ref.md'), 'reference text', 'utf8');
        const backend = {
            resolveSkill: () => ({ name: 's', filePath: join(dir, 'SKILL.md'), baseDir: dir }),
            listNames: () => ['s'],
        };
        const resolver = createSchemeResolver({ skills: backend });
        const resource = await resolver.resolve('skill://s/ref.md');
        expect(resource.content).toBe('reference text');
    });

    it('rejects path traversal', async () => {
        const dir = await makeTempDir();
        const backend = {
            resolveSkill: () => ({ name: 's', filePath: join(dir, 'SKILL.md'), baseDir: dir }),
            listNames: () => ['s'],
        };
        const resolver = createSchemeResolver({ skills: backend });
        await expect(resolver.resolve('skill://s/../../../etc/passwd')).rejects.toThrow(/escape|traversal/i);
    });

    it('does not collapse with skill-loader discovery (backend is the single seam)', async () => {
        const seen: string[] = [];
        const backend = {
            resolveSkill(name: string) {
                seen.push(name);
                return undefined;
            },
            listNames: () => [],
        };
        const resolver = createSchemeResolver({ skills: backend });
        await expect(resolver.resolve('skill://nope')).rejects.toThrow(/not found/);
        expect(seen).toEqual(['nope']);
    });
});

describe('SchemeResolver: rule:// via RuleSchemeBackend', () => {
    it('resolves rule content from the injected backend', async () => {
        const backend = {
            resolveRule: (name: string) => (name === 'no-leak' ? { name, content: 'Do not leak' } : undefined),
            listNames: () => ['no-leak'],
        };
        const resolver = createSchemeResolver({ rules: backend });
        const resource = await resolver.resolve('rule://no-leak');
        expect(resource.content).toBe('Do not leak');
    });

    it('errors on miss', async () => {
        const resolver = createSchemeResolver({
            rules: { resolveRule: () => undefined, listNames: () => [] },
        });
        await expect(resolver.resolve('rule://x')).rejects.toThrow(/not found/);
    });
});

describe('SchemeResolver: conflict:// read + write', () => {
    async function setupConflictFile(): Promise<{ file: string; store: InMemoryConflictStore }> {
        const dir = await makeTempDir();
        const file = join(dir, 'merged.ts');
        await writeFile(file, 'before\n<<<<<<< HEAD\nour line\n=======\ntheir line\n>>>>>>> topic\nafter\n', 'utf8');
        const store = new InMemoryConflictStore();
        const blocks = parseConflictBlocks(await readFile(file, 'utf8'));
        for (const block of blocks) {
            store.register({ filePath: file, ours: block.ours, theirs: block.theirs, base: '' });
        }
        return { file, store };
    }

    it('reads a registered conflict', async () => {
        const { store } = await setupConflictFile();
        const resolver = createSchemeResolver({ conflicts: store });
        const resource = await resolver.resolve('conflict://1');
        expect(resource.content).toContain('our line');
        expect(resource.content).toContain('their line');
        expect(resource.notes?.some((n) => n.includes('@ours|@theirs|@base'))).toBe(true);
    });

    it('lists all conflicts via conflict://*', async () => {
        const { store } = await setupConflictFile();
        const resolver = createSchemeResolver({ conflicts: store });
        const resource = await resolver.resolve('conflict://*');
        expect(resource.content).toContain('conflict://1');
    });

    it('write conflict://1 @theirs resolves the block in place', async () => {
        const { file, store } = await setupConflictFile();
        const resolver = createSchemeResolver({ conflicts: store });
        await resolver.write('conflict://1', '@theirs');
        const after = await readFile(file, 'utf8');
        expect(after).toBe('before\ntheir line\nafter\n');
    });

    it('write conflict://1 @ours keeps our side', async () => {
        const { file, store } = await setupConflictFile();
        const resolver = createSchemeResolver({ conflicts: store });
        await resolver.write('conflict://1', '@ours');
        const after = await readFile(file, 'utf8');
        expect(after).toBe('before\nour line\nafter\n');
    });

    it('rejects an invalid choice', async () => {
        const { store } = await setupConflictFile();
        const resolver = createSchemeResolver({ conflicts: store });
        await expect(resolver.write('conflict://1', '@middle')).rejects.toThrow(/@ours, @theirs, or @base/);
    });

    it('rejects write to a read-only scheme', async () => {
        const store = new InMemoryAgentOutputStore();
        store.register({ id: 'x', content: 'y' });
        const resolver = createSchemeResolver({ agentOutputs: store });
        await expect(resolver.write('agent://x', 'data')).rejects.toThrow(/read-only/);
    });
});

describe('SchemeResolver: unknown scheme + missing backend', () => {
    it('unknown scheme surfaces a clear error listing registered schemes', async () => {
        const store = new InMemoryAgentOutputStore();
        const resolver = createSchemeResolver({ agentOutputs: store });
        await expect(resolver.resolve('pr://1')).rejects.toThrow(/Unknown scheme: pr/);
    });

    it('matches only registered schemes', () => {
        const resolver = createSchemeResolver({ agentOutputs: new InMemoryAgentOutputStore() });
        expect(resolver.matches('agent://x')).toBe(true);
        expect(resolver.matches('pr://1')).toBe(false);
        expect(resolver.matches('src/foo.ts')).toBe(false);
    });
});

describe('interceptors', () => {
    it('interceptRead returns undefined for non-scheme paths', async () => {
        const resolver = createSchemeResolver({ agentOutputs: new InMemoryAgentOutputStore() });
        expect(await interceptRead(resolver, 'src/foo.ts')).toBeUndefined();
    });

    it('interceptRead resolves scheme paths', async () => {
        const store = new InMemoryAgentOutputStore();
        store.register({ id: 'x', content: 'hello' });
        const resolver = createSchemeResolver({ agentOutputs: store });
        const result = await interceptRead(resolver, 'agent://x');
        expect(result?.content).toBe('hello');
        expect(result?.sourceLabel).toBe('agent://x');
    });

    it('interceptWrite returns false for non-scheme paths and true when handled', async () => {
        const dir = await makeTempDir();
        const file = join(dir, 'c.ts');
        await writeFile(file, 'a\n<<<<<<< H\nx\n=======\ny\n>>>>>>> T\nb\n', 'utf8');
        const store = new InMemoryConflictStore();
        const blocks = parseConflictBlocks(await readFile(file, 'utf8'));
        for (const block of blocks) {
            store.register({ filePath: file, ours: block.ours, theirs: block.theirs, base: '' });
        }
        const resolver = createSchemeResolver({ conflicts: store });
        expect(await interceptWrite(resolver, 'src/foo.ts', 'x')).toBe(false);
        expect(await interceptWrite(resolver, 'conflict://1', '@theirs' as ConflictChoice)).toBe(true);
        expect(await readFile(file, 'utf8')).toBe('a\ny\nb\n');
    });
});
