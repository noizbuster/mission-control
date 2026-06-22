import type { WorkflowSpec } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { stripJsoncComments } from './jsonc-parser.js';
import { DEFAULT_MAX_WORKFLOW_FILE_BYTES, type DiscoverWorkflowsResult, discoverWorkflows } from './workflow-loader.js';
import { WorkflowRegistry } from './workflow-registry.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TempArea = { readonly root: string; readonly workspace: string; readonly userConfig: string };

async function makeTempArea(): Promise<TempArea> {
    const root = await mkdtemp(join(tmpdir(), 'workflows-test-'));
    const workspace = join(root, 'workspace');
    const userConfig = join(root, 'user-config');
    await mkdir(workspace, { recursive: true });
    await mkdir(userConfig, { recursive: true });
    return { root, workspace, userConfig };
}

async function writeWorkflow(baseDir: string, relativePath: string, content: string): Promise<string> {
    const filePath = join(baseDir, relativePath);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return filePath;
}

function validWorkflowJson(name: string, description?: string): string {
    const desc = description !== undefined ? `,\n  "description": ${JSON.stringify(description)}` : '';
    return `{
  "name": ${JSON.stringify(name)}${desc},
  "graph": {
    "id": "graph-${name}",
    "entryNodeId": "start",
    "nodes": [
      { "id": "start", "kind": "llm", "label": "Start" }
    ],
    "edges": [],
    "rules": [],
    "policies": []
  }
}`;
}

describe('stripJsoncComments', () => {
    it('strips line comments', () => {
        expect(stripJsoncComments('{"a": 1 // comment\n}')).toBe('{"a": 1 \n}');
    });

    it('strips block comments', () => {
        expect(stripJsoncComments('{"a": /* block */ 1}')).toBe('{"a":  1}');
    });

    it('does not strip comment-like text inside strings', () => {
        expect(stripJsoncComments('{"url": "http://example.com"}')).toBe('{"url": "http://example.com"}');
    });

    it('preserves escaped quotes inside strings', () => {
        expect(stripJsoncComments('{"msg": "say \\"hi\\" // not a comment"}')).toBe(
            '{"msg": "say \\"hi\\" // not a comment"}',
        );
    });

    it('handles unterminated block comment gracefully', () => {
        expect(stripJsoncComments('{"a": 1 /* never closed')).toBe('{"a": 1 ');
    });
});

describe('WorkflowRegistry', () => {
    function spec(name: string): WorkflowSpec {
        return {
            name,
            graph: {
                id: `graph-${name}`,
                entryNodeId: 'start',
                nodes: [{ id: 'start', kind: 'llm' }],
                edges: [],
                rules: [],
                policies: [],
            },
        };
    }

    it('registers discovered workflows from constructor', () => {
        const registry = new WorkflowRegistry([spec('alpha'), spec('beta')]);
        expect(registry.names()).toEqual(['alpha', 'beta']);
        expect(registry.list().length).toBe(2);
    });

    it('lookup resolves by name', () => {
        const registry = new WorkflowRegistry([spec('alpha')]);
        expect(registry.lookup('alpha')?.name).toBe('alpha');
        expect(registry.lookup('missing')).toBeUndefined();
    });

    it('programmatic register adds a new workflow', () => {
        const registry = new WorkflowRegistry([]);
        registry.register(spec('manual'));
        expect(registry.lookup('manual')?.name).toBe('manual');
        expect(registry.names()).toEqual(['manual']);
    });

    it('register replaces an existing name but keeps insertion order', () => {
        const registry = new WorkflowRegistry([spec('alpha')]);
        const replacement = spec('alpha');
        registry.register(replacement);
        expect(registry.names()).toEqual(['alpha']);
        expect(registry.lookup('alpha')).toBe(replacement);
    });
});

describe('discoverWorkflows', () => {
    let area: TempArea;

    async function setup(): Promise<TempArea> {
        area = await makeTempArea();
        return area;
    }

    async function teardown(): Promise<void> {
        await rm(area.root, { recursive: true, force: true });
    }

    it('(a) discovers valid .workflow.json and .workflow.jsonc files', async () => {
        await setup();
        try {
            await writeWorkflow(
                area.workspace,
                '.mctrl/workflows/alpha.workflow.json',
                validWorkflowJson('alpha', 'Alpha'),
            );
            await writeWorkflow(
                area.workspace,
                '.mctrl/workflows/beta.workflow.jsonc',
                validWorkflowJson('beta', 'Beta'),
            );

            const result = await discoverWorkflows({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });

            expect(result.diagnostics).toEqual([]);
            expect(result.workflows.length).toBe(2);
            const names = result.workflows.map((w) => w.name).sort();
            expect(names).toEqual(['alpha', 'beta']);
        } finally {
            await teardown();
        }
    });

    it('(b) rejects broken workflows with diagnostics, never throws', async () => {
        await setup();
        try {
            await writeWorkflow(area.workspace, '.mctrl/workflows/good.workflow.json', validWorkflowJson('good'));
            await writeWorkflow(area.workspace, '.mctrl/workflows/bad-json.workflow.json', '{not valid json');
            await writeWorkflow(area.workspace, '.mctrl/workflows/no-graph.workflow.json', '{"name": "no-graph"}');

            const result = await discoverWorkflows({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });

            expect(result.workflows.map((w) => w.name)).toEqual(['good']);
            const codes = result.diagnostics.map((d) => d.code);
            expect(codes).toContain('parse_error');
            expect(codes).toContain('validation_error');
        } finally {
            await teardown();
        }
    });

    it('(c) first-wins dedup: global scope beats project scope on name collision', async () => {
        await setup();
        try {
            await writeWorkflow(
                area.userConfig,
                'workflows/dup.workflow.json',
                validWorkflowJson('dup', 'from global'),
            );
            await writeWorkflow(
                area.workspace,
                '.mctrl/workflows/dup.workflow.json',
                validWorkflowJson('dup', 'from project'),
            );

            const result = await discoverWorkflows({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });

            expect(result.workflows.length).toBe(1);
            expect(result.workflows[0]?.description).toBe('from global');
            const dup = result.diagnostics.find((d) => d.code === 'duplicate_name');
            expect(dup?.workflowName).toBe('dup');
        } finally {
            await teardown();
        }
    });

    it('(c2) first-wins dedup: .mctrl beats .agents', async () => {
        await setup();
        try {
            await writeWorkflow(
                area.workspace,
                '.mctrl/workflows/shared.workflow.json',
                validWorkflowJson('shared', 'from mctrl'),
            );
            await writeWorkflow(
                area.workspace,
                '.agents/workflows/shared.workflow.json',
                validWorkflowJson('shared', 'from agents'),
            );

            const result = await discoverWorkflows({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });

            expect(result.workflows.length).toBe(1);
            expect(result.workflows[0]?.description).toBe('from mctrl');
        } finally {
            await teardown();
        }
    });

    it('(d) denylist: workflows under temp/ref-repos are NOT discovered', async () => {
        await setup();
        try {
            const refRepoWorkspace = join(area.root, 'temp', 'ref-repos', 'some-repo');
            await mkdir(join(refRepoWorkspace, '.mctrl', 'workflows'), { recursive: true });
            await writeWorkflow(refRepoWorkspace, '.mctrl/workflows/leaked.workflow.json', validWorkflowJson('leaked'));

            const result = await discoverWorkflows({
                workspaceRoot: refRepoWorkspace,
                userConfigDir: area.userConfig,
            });

            expect(result.workflows.find((w) => w.name === 'leaked')).toBeUndefined();
        } finally {
            await teardown();
        }
    });

    it('(d2) denylist: walker prunes denylisted directory names (node_modules)', async () => {
        await setup();
        try {
            await writeWorkflow(area.workspace, '.mctrl/workflows/ok.workflow.json', validWorkflowJson('ok'));
            await writeWorkflow(
                area.workspace,
                '.mctrl/workflows/node_modules/hidden.workflow.json',
                validWorkflowJson('hidden'),
            );

            const result = await discoverWorkflows({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });

            expect(result.workflows.map((w) => w.name)).toEqual(['ok']);
        } finally {
            await teardown();
        }
    });

    it('(e) JSONC comments are stripped before parsing', async () => {
        await setup();
        try {
            const jsonc = `{
  // top-level workflow
  "name": "commented",
  "description": "has comments", /* inline block */
  "graph": {
    "id": "g", // graph id
    "entryNodeId": "start",
    "nodes": [
      { "id": "start", "kind": "llm" }
    ]
  }
}`;
            await writeWorkflow(area.workspace, '.mctrl/workflows/commented.workflow.jsonc', jsonc);

            const result = await discoverWorkflows({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });

            expect(result.diagnostics).toEqual([]);
            expect(result.workflows.length).toBe(1);
            expect(result.workflows[0]?.name).toBe('commented');
            expect(result.workflows[0]?.description).toBe('has comments');
        } finally {
            await teardown();
        }
    });

    it('(f) oversized workflow file is skipped with size-bound diagnostic', async () => {
        await setup();
        try {
            const padding = ' '.repeat(DEFAULT_MAX_WORKFLOW_FILE_BYTES + 100);
            const oversized = `{"name":"big","graph":{"id":"g","entryNodeId":"s","nodes":[{"id":"s","kind":"llm"}]},"padding":${JSON.stringify(padding)}}`;
            await writeWorkflow(area.workspace, '.mctrl/workflows/big.workflow.json', oversized);

            const result = await discoverWorkflows({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });

            expect(result.workflows.length).toBe(0);
            expect(result.diagnostics.some((d) => d.code === 'size_exceeded')).toBe(true);
        } finally {
            await teardown();
        }
    });

    it('(g) does not follow symlinked directories out of the scope', async () => {
        await setup();
        try {
            const outsideDir = join(area.root, 'outside', 'stolen');
            await mkdir(outsideDir, { recursive: true });
            await writeFile(join(outsideDir, 'stolen.workflow.json'), validWorkflowJson('stolen'), 'utf8');
            const scopeDir = join(area.workspace, '.mctrl', 'workflows');
            await mkdir(scopeDir, { recursive: true });
            await symlink(outsideDir, join(scopeDir, 'escape-link'), 'dir');

            const result = await discoverWorkflows({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });

            expect(result.workflows.find((w) => w.name === 'stolen')).toBeUndefined();
        } finally {
            await teardown();
        }
    });

    it('(h) does not throw when scope dirs are missing', async () => {
        await setup();
        try {
            const result: DiscoverWorkflowsResult = await discoverWorkflows({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });
            expect(result.workflows).toEqual([]);
            expect(result.diagnostics).toEqual([]);
        } finally {
            await teardown();
        }
    });

    it('(i) validates discovered workflows against WorkflowSpecSchema', async () => {
        await setup();
        try {
            await writeWorkflow(area.workspace, '.mctrl/workflows/valid.workflow.json', validWorkflowJson('validated'));

            const result = await discoverWorkflows({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });

            expect(result.workflows.length).toBe(1);
            const wf = result.workflows[0];
            expect(wf?.graph.nodes.length).toBe(1);
            expect(wf?.graph.entryNodeId).toBe('start');
        } finally {
            await teardown();
        }
    });
});
