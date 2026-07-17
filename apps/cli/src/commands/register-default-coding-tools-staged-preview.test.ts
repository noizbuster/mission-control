import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowAllPermission, noLspServers, trustedProjectTrustStore } from './interactive-coding-tools-test-support';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { closeProductionToolRegistry, type ProductionToolRegistry } from './production-tool-registry';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourceText = 'export function report(value: string) { console.log(value); }\n';
const rewrittenText = 'export function report(value: string) { logger.info(value); }\n';

describe('default coding tool staged preview integration', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('applies an ast_grep rewrite through resolve when production permission approves', async () => {
        // Given
        const workspaceRoot = await prepareProductionWorkspace(tempRoots);
        const permissionRequests: PermissionRequest[] = [];
        const production = await createProductionRegistry(
            workspaceRoot,
            recordPermissionDecisions(permissionRequests, 'allow'),
        );
        registries.push(production);

        // When
        const proposal = await invokeTool(production, 'ast_grep', {
            mode: 'rewrite',
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            paths: ['sample.ts'],
            language: 'typescript',
        });
        const beforeApply = await readFile(join(workspaceRoot, 'sample.ts'), 'utf8');
        const applied = await invokeTool(production, 'resolve', {
            action: 'apply',
            reason: 'approved structural logging rewrite',
        });

        // Then
        expect(proposal.result.status).toBe('completed');
        expect(beforeApply).toBe(sourceText);
        expect(applied.result.status).toBe('completed');
        expect(applied.structuredOutput).toMatchObject({ status: 'applied', sourceToolName: 'ast_grep' });
        expect(permissionRequests).toHaveLength(1);
        expect(permissionRequests[0]).toMatchObject({
            action: 'ast_edit apply',
            permission: { kind: 'edit', patterns: ['sample.ts'], workspaceRoot },
        });
        expect(await readFile(join(workspaceRoot, 'sample.ts'), 'utf8')).toBe(rewrittenText);
    });

    it('blocks ast_edit resolve application when production permission denies', async () => {
        // Given
        const workspaceRoot = await prepareProductionWorkspace(tempRoots);
        const permissionRequests: PermissionRequest[] = [];
        const production = await createProductionRegistry(
            workspaceRoot,
            recordPermissionDecisions(permissionRequests, 'deny'),
        );
        registries.push(production);
        const proposal = await invokeTool(production, 'ast_edit', {
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            paths: ['sample.ts'],
            language: 'typescript',
        });

        // When
        const denied = await invokeTool(production, 'resolve', {
            action: 'apply',
            reason: 'denied structural logging rewrite',
        });

        // Then
        expect(proposal.result.status).toBe('completed');
        expect(denied.result.status).toBe('failed');
        expect(denied.result.error?.message).toContain('denied by staged preview test');
        expect(permissionRequests.map((request) => request.action)).toEqual(['ast_edit apply']);
        expect(await readFile(join(workspaceRoot, 'sample.ts'), 'utf8')).toBe(sourceText);
    });

    it('fails closed when resolve apply has no staged preview', async () => {
        // Given
        const workspaceRoot = await prepareProductionWorkspace(tempRoots);
        const production = await createProductionRegistry(workspaceRoot, allowAllPermission);
        registries.push(production);

        // When
        const result = await invokeTool(production, 'resolve', {
            action: 'apply',
            reason: 'nothing was staged',
        });

        // Then
        expect(result.result.status).toBe('failed');
        expect(result.result.error?.message).toContain('No pending preview');
        expect(await readFile(join(workspaceRoot, 'sample.ts'), 'utf8')).toBe(sourceText);
    });

    it('keeps staged previews local to their production registry lifetime', async () => {
        // Given
        const workspaceRoot = await prepareProductionWorkspace(tempRoots);
        const proposingRegistry = await createProductionRegistry(workspaceRoot, allowAllPermission);
        const distinctRegistry = await createProductionRegistry(workspaceRoot, allowAllPermission);
        registries.push(proposingRegistry, distinctRegistry);
        const proposal = await invokeTool(proposingRegistry, 'ast_grep', {
            mode: 'rewrite',
            pattern: 'console.log($X)',
            replacement: 'logger.info($X)',
            paths: ['sample.ts'],
            language: 'typescript',
        });

        // When
        const crossRegistryApply = await invokeTool(distinctRegistry, 'resolve', {
            action: 'apply',
            reason: 'attempt cross-registry resolution',
        });

        // Then
        expect(proposal.result.status).toBe('completed');
        expect(crossRegistryApply.result.status).toBe('failed');
        expect(crossRegistryApply.result.error?.message).toContain('No pending preview');
        expect(await readFile(join(workspaceRoot, 'sample.ts'), 'utf8')).toBe(sourceText);
    });
});

async function prepareProductionWorkspace(tempRoots: string[]): Promise<string> {
    const configRoot = await createTempRoot(tempRoots, 'mctrl-staged-preview-config-');
    const dataRoot = await createTempRoot(tempRoots, 'mctrl-staged-preview-data-');
    const workspaceRoot = await createTempRoot(tempRoots, 'mctrl-staged-preview-workspace-');
    const addonPath = join(configRoot, 'fake-natives.cjs');
    await writeFile(join(workspaceRoot, 'sample.ts'), sourceText, 'utf8');
    await writeFile(addonPath, fakeNativesAddonSource(), 'utf8');
    vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
    vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
    vi.stubEnv('MCTRL_NATIVES_PATH', addonPath);
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('PARALLEL_API_KEY', '');
    return workspaceRoot;
}

async function createProductionRegistry(
    workspaceRoot: string,
    requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>,
): Promise<ProductionToolRegistry> {
    return createNonInteractiveToolRegistry({
        workspaceRoot,
        requestPermission,
        projectTrustStore: trustedProjectTrustStore,
        lspServerManagerDeps: noLspServers,
    });
}

async function invokeTool(
    production: ProductionToolRegistry,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
) {
    const advertisement = production.registry.advertise().find((candidate) => candidate.name === toolName);
    if (advertisement === undefined) throw new TypeError(`${toolName} was not advertised`);
    return production.registry.invoke({
        toolCallId: `${toolName}_staged_preview_test`,
        toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

function recordPermissionDecisions(
    requests: PermissionRequest[],
    status: 'allow' | 'deny',
): (request: PermissionRequest) => Promise<PermissionDecision> {
    return async (request) => {
        requests.push(request);
        return {
            requestId: request.id,
            status,
            reason: status === 'allow' ? 'allowed by staged preview test' : 'denied by staged preview test',
        };
    };
}

async function createTempRoot(tempRoots: string[], prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
}

function fakeNativesAddonSource(): string {
    return String.raw`
const { readFileSync } = require('node:fs');

module.exports = {
    countTokens(text) {
        return text.length;
    },
    astRewrite(pattern, paths, options) {
        if (pattern !== 'console.log($X)' || options.replacement !== 'logger.info($X)') return [];
        const changes = [];
        for (const path of paths) {
            const source = readFileSync(path, 'utf8');
            const marker = 'console.log(';
            let cursor = 0;
            for (;;) {
                const start = source.indexOf(marker, cursor);
                if (start === -1) break;
                const close = source.indexOf(')', start + marker.length);
                if (close === -1) break;
                const before = source.slice(start, close + 1);
                const captured = source.slice(start + marker.length, close);
                const prefix = source.slice(0, start);
                const byteStart = Buffer.byteLength(prefix, 'utf8');
                const startLine = prefix.split('\n').length;
                const lastNewline = prefix.lastIndexOf('\n');
                const startColumn = start - lastNewline;
                changes.push({
                    path,
                    before,
                    after: options.replacement.replace('$X', captured),
                    byteStart,
                    byteEnd: byteStart + Buffer.byteLength(before, 'utf8'),
                    startLine,
                    startColumn,
                    endLine: startLine,
                    endColumn: startColumn + before.length,
                });
                cursor = close + 1;
            }
        }
        return changes;
    },
};
`;
}
