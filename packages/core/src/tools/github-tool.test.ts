import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandExecutionRequest, CommandExecutionResult } from './command-run-executor';
import { buildGhArgs, type GithubInput, registerGithubTool } from './github-tool';
import { type ToolInvocationSettlement, ToolRegistry } from './tool-registry';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

describe('github tool', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('is not registered when gh is absent (config-gating)', async () => {
        const registry = new ToolRegistry();
        const advertisement = await registerGithubTool(registry, {
            workspaceRoot: await tempRoot('mctrl-gh-absent-'),
            workspaceTrust: 'trusted',
            requestPermission: allowPermission,
            ghAvailable: () => false,
            executor: async () => completedResult(),
        });

        expect(advertisement).toBeNull();
        expect(registry.advertise().find((tool) => tool.name === 'github')).toBeUndefined();
    });

    it('advertises the network capability class when gh is present', async () => {
        const registry = await createRegistry({ ghAvailable: () => true, executor: async () => completedResult() });

        const advertisement = registry.advertise().find((tool) => tool.name === 'github');
        expect(advertisement).toBeDefined();
        expect(advertisement?.capabilityClasses).toContain('network');
    });

    it('shells repo_view to `gh repo view --json` and returns redacted stdout', async () => {
        const calls: CommandExecutionRequest[] = [];
        const payload = JSON.stringify({ nameWithOwner: 'owner/repo', description: 'demo' });
        const registry = await createRegistry({
            ghAvailable: () => true,
            executor: async (request) => {
                calls.push(request);
                return completedResult({ stdout: payload });
            },
        });

        const settlement = await invokeGithub(registry, { op: 'repo_view', repo: 'owner/repo' });

        expect(settlement.result.status).toBe('completed');
        expect(calls).toHaveLength(1);
        expect(calls[0]?.command).toBe('gh');
        expect(calls[0]?.args).toEqual(['repo', 'view', 'owner/repo', '--json', expect.any(String)]);
        const jsonArgIndex = calls[0]?.args.indexOf('--json') ?? -1;
        expect(calls[0]?.args?.[jsonArgIndex + 1]).toBe(
            'nameWithOwner,description,url,defaultBranchRef,visibility,viewerPermission,primaryLanguage,stargazerCount,forkCount,isArchived,isFork,updatedAt,homepageUrl,repositoryTopics',
        );
        const output = settlement.structuredOutput as { stdout: string };
        expect(output.stdout).toContain('owner/repo');
    });

    it('builds pr_view argv with --repo and includes reviews/comments by default', async () => {
        const calls: CommandExecutionRequest[] = [];
        const registry = await createRegistry({
            ghAvailable: () => true,
            executor: async (request) => {
                calls.push(request);
                return completedResult({ stdout: '{"number":42}' });
            },
        });

        const settlement = await invokeGithub(registry, { op: 'pr_view', pr: 42, repo: 'owner/repo' });

        expect(settlement.result.status).toBe('completed');
        expect(calls[0]?.args).toEqual(expect.arrayContaining(['pr', 'view', '42', '--repo', 'owner/repo', '--json']));
        const jsonArgIndex = calls[0]?.args.indexOf('--json') ?? -1;
        const fields = calls[0]?.args[jsonArgIndex + 1];
        expect(fields).toContain('reviews');
        expect(fields).toContain('comments');
    });

    it('drops comments fields when comments=false', async () => {
        const args = buildGhArgs({ op: 'pr_view', pr: '7', repo: 'o/r', comments: false });
        const jsonIndex = args.indexOf('--json');
        const fields = args[jsonIndex + 1];
        expect(fields).toContain('files');
        expect(fields).not.toContain('reviews');
        expect(fields).not.toContain('comments');
    });

    it('builds issue_view argv with --repo', async () => {
        const args = buildGhArgs({ op: 'issue_view', issue: 99, repo: 'o/r' });
        expect(args).toEqual(expect.arrayContaining(['issue', 'view', '99', '--repo', 'o/r', '--json']));
    });

    it('builds code_search argv with limit and --repo scope', async () => {
        const args = buildGhArgs({ op: 'code_search', query: 'fn main', repo: 'o/r', limit: 5 });
        expect(args).toEqual(expect.arrayContaining(['search', 'code', 'fn main', '--limit', '5', '--repo', 'o/r']));
    });

    it('clamps search limit to the max and defaults when omitted', () => {
        const defaulted = buildGhArgs({ op: 'search_issues', query: 'bug' });
        expect(defaulted[defaulted.indexOf('--limit') + 1]).toBe('10');

        const clamped = buildGhArgs({ op: 'search_prs', query: 'bug', limit: 999 });
        expect(clamped[clamped.indexOf('--limit') + 1]).toBe('50');
    });

    it('builds actions_run_view and actions_run_watch identically (single snapshot)', () => {
        const view = buildGhArgs({ op: 'actions_run_view', run: 123, repo: 'o/r' });
        const watch = buildGhArgs({ op: 'actions_run_watch', run: 123, repo: 'o/r' });
        expect(view).toEqual(['run', 'view', '123', '--repo', 'o/r', '--json', expect.any(String)]);
        expect(watch).toEqual(view);
    });

    it('builds actions_run_list with a clamped limit', () => {
        const args = buildGhArgs({ op: 'actions_run_list', repo: 'o/r', limit: 100 });
        expect(args[args.indexOf('--limit') + 1]).toBe('30');
    });

    it('requires a selector for view ops via buildGhArgs', () => {
        expect(() => buildGhArgs({ op: 'pr_view' })).toThrow(/pr is required/);
        expect(() => buildGhArgs({ op: 'issue_view' })).toThrow(/issue is required/);
        expect(() => buildGhArgs({ op: 'actions_run_view' })).toThrow(/run is required/);
        expect(() => buildGhArgs({ op: 'code_search' })).toThrow(/query is required/);
    });

    it('requests a network permission before spawning and surfaces approval_required when not allowed', async () => {
        const calls: CommandExecutionRequest[] = [];
        const permissionRequests: PermissionRequest[] = [];
        const registry = await createRegistry({
            ghAvailable: () => true,
            requestPermission: (request) => {
                permissionRequests.push(request);
                return requireApprovalDecision(request);
            },
            executor: async (request) => {
                calls.push(request);
                return completedResult();
            },
        });

        const settlement = await invokeGithub(registry, { op: 'repo_view', repo: 'owner/repo' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('approval_required');
        expect(permissionRequests).toMatchObject([
            {
                action: 'github',
                permission: { kind: 'network' },
            },
        ]);
        expect(permissionRequests[0]?.reason).toContain('gh repo view');
        expect(calls).toEqual([]);
    });

    it('surfaces approval_denied when the decision is deny', async () => {
        const calls: CommandExecutionRequest[] = [];
        const registry = await createRegistry({
            ghAvailable: () => true,
            requestPermission: (request) => denyPermission(request),
            executor: async (request) => {
                calls.push(request);
                return completedResult();
            },
        });

        const settlement = await invokeGithub(registry, { op: 'repo_view' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('approval_denied');
        expect(calls).toEqual([]);
    });

    it('requires a trusted workspace before permission or spawn', async () => {
        const calls: CommandExecutionRequest[] = [];
        const permissionRequests: PermissionRequest[] = [];
        const registry = await createRegistry({
            workspaceTrust: 'unknown',
            ghAvailable: () => true,
            requestPermission: (request) => {
                permissionRequests.push(request);
                return allowPermission(request);
            },
            executor: async (request) => {
                calls.push(request);
                return completedResult();
            },
        });

        const settlement = await invokeGithub(registry, { op: 'repo_view' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('workspace_not_trusted');
        expect(settlement.result.error?.message).toContain('trusted workspace');
        expect(permissionRequests).toEqual([]);
        expect(calls).toEqual([]);
    });

    it('redacts token-like stdout and forwarded token env across structured output, model output, and events', async () => {
        const envToken = 'ghp_redactedFromEnvToken1234567890';
        const inlineToken = 'sk-proj-githubInlineSecret0987';
        const registry = await createRegistry({
            ghAvailable: () => true,
            hostEnv: { GH_TOKEN: envToken },
            executor: async () =>
                completedResult({
                    stdout: `token=${inlineToken}\nenv=${envToken}\n{"nameWithOwner":"o/r"}`,
                }),
        });

        const settlement = await invokeGithub(registry, { op: 'repo_view', repo: 'o/r' });

        expect(settlement.result.status).toBe('completed');
        const structuredOutput = JSON.stringify(settlement.structuredOutput);
        const modelOutput = settlement.modelOutput?.content ?? '';
        const events = JSON.stringify(settlement.events);

        for (const surface of [structuredOutput, modelOutput, events]) {
            expect(surface).toContain('[REDACTED_CREDENTIAL]');
            expect(surface).not.toContain(envToken);
            expect(surface).not.toContain(inlineToken);
        }
    });

    it('surfaces a redacted command_failed when gh exits non-zero', async () => {
        const secret = 'ghp_failedRunSecretTokenABCDEFGH';
        const registry = await createRegistry({
            ghAvailable: () => true,
            hostEnv: { GH_TOKEN: secret },
            executor: async () => failedResult({ stderr: `auth failed token=${secret}` }),
        });

        const settlement = await invokeGithub(registry, { op: 'pr_view', pr: 1, repo: 'o/r' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('command_failed');
        expect(settlement.result.error?.message).not.toContain(secret);
        expect(settlement.result.error?.message).toContain('[REDACTED_CREDENTIAL]');
    });

    it('aborts and reports command_timed_out when the gh call exceeds the timeout', async () => {
        const registry = await createRegistry({
            ghAvailable: () => true,
            timeoutMs: 5,
            executor: (request) =>
                new Promise<CommandExecutionResult>((resolve) => {
                    request.signal.addEventListener(
                        'abort',
                        () =>
                            resolve({
                                exitCode: null,
                                signal: 'SIGTERM',
                                timedOut: true,
                                stdout: '',
                                stderr: '',
                                durationMs: 5,
                            }),
                        { once: true },
                    );
                }),
        });

        const settlement = await invokeGithub(registry, { op: 'actions_run_list', repo: 'o/r' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('command_timed_out');
    });

    it('completes actions_run_list when approved', async () => {
        const calls: CommandExecutionRequest[] = [];
        const payload = JSON.stringify([{ databaseId: 1, name: 'CI', status: 'completed', conclusion: 'success' }]);
        const registry = await createRegistry({
            ghAvailable: () => true,
            executor: async (request) => {
                calls.push(request);
                return completedResult({ stdout: payload });
            },
        });

        const settlement = await invokeGithub(registry, { op: 'actions_run_list', repo: 'o/r' });

        expect(settlement.result.status).toBe('completed');
        expect(calls[0]?.args).toEqual(expect.arrayContaining(['run', 'list', '--limit', '10', '--repo', 'o/r']));
        const output = settlement.structuredOutput as { stdout: string };
        expect(output.stdout).toContain('CI');
    });
});

type CreateRegistryInput = {
    readonly workspaceRoot?: string;
    readonly workspaceTrust?: 'trusted' | 'denied' | 'unknown';
    readonly requestPermission?: (request: PermissionRequest) => PermissionDecision;
    readonly ghAvailable?: () => boolean;
    readonly executor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly timeoutMs?: number;
    readonly hostEnv?: NodeJS.ProcessEnv;
};

async function createRegistry(input: CreateRegistryInput): Promise<ToolRegistry> {
    const workspaceRoot = input.workspaceRoot ?? (await tempRoot('mctrl-github-'));
    const registry = new ToolRegistry();
    await registerGithubTool(registry, {
        workspaceRoot,
        workspaceTrust: input.workspaceTrust ?? 'trusted',
        requestPermission: input.requestPermission ?? allowPermission,
        ghAvailable: input.ghAvailable ?? (() => true),
        ...(input.executor !== undefined ? { executor: input.executor } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.hostEnv !== undefined ? { hostEnv: input.hostEnv } : {}),
    });
    return registry;
}

async function invokeGithub(registry: ToolRegistry, input: GithubInput): Promise<ToolInvocationSettlement> {
    const advertisement = registry.advertise().find((tool) => tool.name === 'github');
    if (advertisement === undefined) {
        throw new TypeError('github not registered');
    }
    return registry.invoke({
        toolCallId: 'github_call',
        toolName: 'github',
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function denyPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'deny', reason: 'test deny' };
}

function requireApprovalDecision(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'requires_approval', reason: 'needs network approval' };
}

function completedResult(input: { readonly stdout?: string; readonly stderr?: string } = {}): CommandExecutionResult {
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: input.stdout ?? '',
        stderr: input.stderr ?? '',
        durationMs: 1,
    };
}

function failedResult(input: { readonly stdout?: string; readonly stderr?: string }): CommandExecutionResult {
    return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: input.stdout ?? '',
        stderr: input.stderr ?? '',
        durationMs: 1,
    };
}

async function tempRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(path);
    return path;
}
