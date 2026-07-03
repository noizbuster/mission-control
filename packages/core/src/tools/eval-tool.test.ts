import { afterEach, describe, expect, it } from 'vitest';
import { type EvalInput, type EvalOutput } from './eval-schemas.js';
import { createEvalToolRegistration, type EvalToolOptions } from './eval-tool.js';
import { createEvalToolBridge } from './eval-tool-bridge.js';
import { ToolRegistry } from './tool-registry.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

async function makeOptions(): Promise<EvalToolOptions & { workspaceRoot: string }> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'eval-tool-test-'));
    tempDirs.push(workspaceRoot);
    return { workspaceRoot };
}

async function makeOptionsWithFile(
    relativePath: string,
    content: string,
): Promise<EvalToolOptions & { workspaceRoot: string }> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'eval-tool-test-'));
    tempDirs.push(workspaceRoot);
    await writeFile(join(workspaceRoot, relativePath), content, 'utf8');
    return { workspaceRoot };
}

function toolContext() {
    return { toolCallId: 'tc1', toolName: 'eval', signal: new AbortController().signal };
}

describe('eval tool', () => {
    afterEach(async () => {
        const dirs = tempDirs.splice(0, tempDirs.length);
        await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('produces a valid ToolRegistration shape', async () => {
        const registration = createEvalToolRegistration(await makeOptions());
        expect(registration.description.length).toBeGreaterThan(0);
        expect(registration.capabilityClasses).toContain('bash.run');
        expect(registration.parametersJsonSchema).toBeDefined();
        expect(registration.inputSchema).toBeDefined();
        expect(registration.outputSchema).toBeDefined();
        expect(registration.outputLimit.maxModelOutputChars).toBeGreaterThan(0);
        expect(typeof registration.execute).toBe('function');
        expect(typeof registration.toModelOutput).toBe('function');
        expect(registration.guideline).toBeDefined();
        expect(registration.guideline?.length).toBeGreaterThan(0);
    });

    it('has the name "eval"', async () => {
        const registration = createEvalToolRegistration(await makeOptions());
        expect(registration.name).toBe('eval');
    });

    it('executes a simple JS expression and returns its output', async () => {
        const registration = createEvalToolRegistration(await makeOptions());
        const input: EvalInput = {
            cells: [{ language: 'js', code: '1 + 1' }],
        };
        const output = await registration.execute(input, toolContext());
        expect(output.results).toHaveLength(1);
        const first = output.results[0];
        expect(first).toBeDefined();
        expect(first?.exitCode).toBe(0);
        expect(first?.output).toContain('2');
        expect(first?.timedOut).toBe(false);
        expect(first?.truncated).toBe(false);
    });

    it('persists state across cells within one invocation', async () => {
        const registration = createEvalToolRegistration(await makeOptions());
        const input: EvalInput = {
            cells: [
                { language: 'js', code: 'var x = 42' },
                { language: 'js', code: 'x' },
            ],
        };
        const output = await registration.execute(input, toolContext());
        expect(output.results).toHaveLength(2);
        expect(output.results[0]?.exitCode).toBe(0);
        expect(output.results[1]?.exitCode).toBe(0);
        expect(output.results[1]?.output).toContain('42');
    });

    it('reports a timeout when a cell exceeds its timeoutMs', async () => {
        const registration = createEvalToolRegistration(await makeOptions());
        const input: EvalInput = {
            cells: [{ language: 'js', code: 'while (true) {}', timeoutMs: 200 }],
        };
        const output = await registration.execute(input, toolContext());
        expect(output.results).toHaveLength(1);
        expect(output.results[0]?.timedOut).toBe(true);
        expect(output.results[0]?.exitCode).not.toBe(0);
    });

    it('formats results as readable text via toModelOutput', async () => {
        const registration = createEvalToolRegistration(await makeOptions());
        const sample: EvalOutput = {
            results: [
                { output: '42\n', exitCode: 0, truncated: false, timedOut: false },
                {
                    title: 'errored',
                    output: 'boom\n',
                    exitCode: 1,
                    truncated: true,
                    timedOut: false,
                },
            ],
        };
        const formatted = registration.toModelOutput?.(sample) ?? '';
        expect(formatted).toContain('## Cell 1');
        expect(formatted).toContain('42');
        expect(formatted).toContain('## Cell 2: errored');
        expect(formatted).toContain('boom');
        expect(formatted).toContain('[exit code: 1]');
        expect(formatted).toContain('[output truncated]');
    });

    it('registers through a ToolRegistry and is invocable', async () => {
        const registry = new ToolRegistry();
        const advertisement = registry.register(createEvalToolRegistration(await makeOptions()));
        expect(advertisement.name).toBe('eval');
        const settlement = await registry.invoke({
            toolCallId: 'tc-reg',
            toolName: 'eval',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ cells: [{ language: 'js', code: '6 * 7' }] }),
        });
        expect(settlement.result.status).toBe('completed');
        if (settlement.modelOutput !== undefined) {
            expect(settlement.modelOutput.content).toContain('42');
        }
    });

    it('rejects empty cells arrays via the input schema', async () => {
        const registry = new ToolRegistry();
        const advertisement = registry.register(createEvalToolRegistration(await makeOptions()));
        const settlement = await registry.invoke({
            toolCallId: 'tc-empty',
            toolName: 'eval',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ cells: [] }),
        });
        expect(settlement.result.status).toBe('failed');
    });
});

describe('eval tool bridge', () => {
    it('allows read-only tools and blocks eval/task/mcp__', () => {
        const bridge = createEvalToolBridge({ invokeTool: async () => 'ok' });
        // Allowed
        expect(bridge.isToolAllowed('read')).toBe(true);
        expect(bridge.isToolAllowed('ls')).toBe(true);
        expect(bridge.isToolAllowed('grep')).toBe(true);
        expect(bridge.isToolAllowed('find')).toBe(true);
        expect(bridge.isToolAllowed('glob')).toBe(true);
        expect(bridge.isToolAllowed('repo.read')).toBe(true);
        expect(bridge.isToolAllowed('repo.list')).toBe(true);
        expect(bridge.isToolAllowed('repo.search')).toBe(true);
        // Blocked explicitly
        expect(bridge.isToolAllowed('eval')).toBe(false);
        expect(bridge.isToolAllowed('task')).toBe(false);
        // MCP namespaced blocked
        expect(bridge.isToolAllowed('mcp__foo__bar')).toBe(false);
        // Default-deny for anything not on the allowlist
        expect(bridge.isToolAllowed('bash.run')).toBe(false);
        expect(bridge.isToolAllowed('file.write')).toBe(false);
        expect(bridge.isToolAllowed('webfetch')).toBe(false);
    });

    it('routes allowed tool calls through invokeTool with the original args', async () => {
        const seen: Array<{ readonly name: string; readonly args: unknown }> = [];
        const bridge = createEvalToolBridge({
            invokeTool: async (name, args) => {
                seen.push({ name, args });
                return `invoked:${name}`;
            },
        });
        const result = await bridge.handleToolCall('read', { path: '/tmp' });
        expect(result).toBe('invoked:read');
        expect(seen).toEqual([{ name: 'read', args: { path: '/tmp' } }]);
    });

    it('throws when a blocked tool is requested and does not call invokeTool', async () => {
        let called = false;
        const bridge = createEvalToolBridge({
            invokeTool: async () => {
                called = true;
                return 'should not reach';
            },
        });
        await expect(bridge.handleToolCall('eval', {})).rejects.toThrow(/eval re-entry blocked/);
        await expect(bridge.handleToolCall('task', {})).rejects.toThrow(/eval re-entry blocked/);
        await expect(bridge.handleToolCall('mcp__foo__bar', {})).rejects.toThrow(/eval re-entry blocked/);
        expect(called).toBe(false);
    });
});

describe('eval tool — python cells', () => {
    afterEach(async () => {
        const dirs = tempDirs.splice(0, tempDirs.length);
        await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('executes a python cell and returns captured stdout', async () => {
        const registration = createEvalToolRegistration(await makeOptions());
        const output = await registration.execute(
            { cells: [{ language: 'py', code: 'print("hello from python")' }] },
            toolContext(),
        );
        expect(output.results).toHaveLength(1);
        expect(output.results[0]?.exitCode).toBe(0);
        expect(output.results[0]?.output).toContain('hello from python');
    });

    it('persists python state across cells within one invocation', async () => {
        const registration = createEvalToolRegistration(await makeOptions());
        const output = await registration.execute(
            {
                cells: [
                    { language: 'py', code: 'total = 0\nfor i in range(5):\n    total += i' },
                    { language: 'py', code: 'print(total)' },
                ],
            },
            toolContext(),
        );
        expect(output.results[1]?.exitCode).toBe(0);
        expect(output.results[1]?.output).toContain('10');
    });

    it('returns a clean error result for malformed python without crashing', async () => {
        const registration = createEvalToolRegistration(await makeOptions());
        const output = await registration.execute({ cells: [{ language: 'py', code: 'def (' }] }, toolContext());
        expect(output.results).toHaveLength(1);
        expect(output.results[0]?.exitCode).not.toBe(0);
        expect(output.results[0]?.timedOut).toBe(false);
    });

    it('a python cell reads a workspace file via the bridge read() helper', async () => {
        const options = await makeOptionsWithFile('data.csv', 'name,score\nalice,3\nbob,7\n');
        const registration = createEvalToolRegistration(options);
        const output = await registration.execute(
            { cells: [{ language: 'py', code: 'data = read("data.csv")\nprint(len(data.splitlines()))' }] },
            toolContext(),
        );
        expect(output.results[0]?.exitCode).toBe(0);
        expect(output.results[0]?.output).toContain('3');
    });
});

describe('eval tool — JS bridge re-entry', () => {
    afterEach(async () => {
        const dirs = tempDirs.splice(0, tempDirs.length);
        await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('a JS cell calls read() via the bridge and returns file content', async () => {
        const options = await makeOptionsWithFile('payload.txt', 'bridge-content-42');
        const registration = createEvalToolRegistration(options);
        const output = await registration.execute(
            {
                cells: [
                    {
                        language: 'js',
                        code: 'const text = await read("payload.txt"); console.log(text)',
                    },
                ],
            },
            toolContext(),
        );
        expect(output.results[0]?.exitCode).toBe(0);
        expect(output.results[0]?.output).toContain('bridge-content-42');
    });

    it('python and JS cells share workspace file access via the bridge prelude', async () => {
        const options = await makeOptionsWithFile('scores.csv', 'name,score\nalice,3\nbob,7\ncleo,11\n');
        const registration = createEvalToolRegistration(options);
        const output = await registration.execute(
            {
                cells: [
                    {
                        language: 'py',
                        title: 'load csv',
                        code: 'rows = [l for l in read("scores.csv").splitlines() if l.strip()]\nprint("rows", len(rows))',
                    },
                    {
                        language: 'js',
                        title: 'reduce scores',
                        code: 'const csv = await read("scores.csv");\nconst sum = csv.trim().split("\\n").slice(1).reduce((a, l) => a + Number(l.split(",")[1]), 0);\nconsole.log("sum", sum);',
                    },
                ],
            },
            toolContext(),
        );
        expect(output.results[0]?.exitCode).toBe(0);
        expect(output.results[0]?.output).toContain('rows 4');
        expect(output.results[1]?.exitCode).toBe(0);
        expect(output.results[1]?.output).toContain('sum 21');
    });
});
