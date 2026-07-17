import type { PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliAllowsAction, createCliPermissionDecision } from './cli-permission-policy';
import { createInteractiveToolRegistry } from './interactive-coding-tools';
import { fakeBroker, noLspServers, trustedProjectTrustStore } from './interactive-coding-tools-test-support';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { closeProductionToolRegistry, type ProductionToolRegistry } from './production-tool-registry';
import { createBufferedChatOutput } from './run-agent-chat-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('default shell tool registration', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('omits interactive_bash when a trusted production registry reports no tmux', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots, 'mctrl-shell-tools-no-tmux-');

        // When
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowPermission,
            enableTrustedBash: true,
            tmuxAvailable: false,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
        });
        registries.push(production);
        const advertised = advertisedNames(production);

        // Then
        expect(advertised).toContain('bash.run');
        expect(advertised).not.toContain('interactive_bash');
    });

    it('advertises interactive_bash for a trusted production registry with tmux while shell transport stays unavailable', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots, 'mctrl-shell-tools-tmux-');
        const output = createBufferedChatOutput();

        // When
        const production = await createInteractiveToolRegistry(
            {
                workspaceRoot,
                sessionId: 'session_shell_tools',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                output: output.output,
                emitEvent: () => undefined,
                enableTrustedBash: true,
                tmuxAvailable: true,
                projectTrustStore: trustedProjectTrustStore,
                lspServerManagerDeps: noLspServers,
            },
            fakeBroker(),
        );
        registries.push(production);
        const advertised = advertisedNames(production);
        const transportAvailable = advertised.includes('shell.session');

        // Then
        expect(advertised).toContain('interactive_bash');
        expect(transportAvailable).toBe(false);
    });

    it('omits bash-class shell tools when the production registry is not trust-enabled', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots, 'mctrl-shell-tools-untrusted-');

        // When
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowPermission,
            enableTrustedBash: false,
            tmuxAvailable: true,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
        });
        registries.push(production);
        const advertised = advertisedNames(production);

        // Then
        expect(advertised).not.toContain('bash.run');
        expect(advertised).not.toContain('interactive_bash');
        expect(advertised).not.toContain('shell.session');
    });
});

describe('default shell tool permission actions', () => {
    it('scopes interactive_bash through bash approval when the tool is registered', async () => {
        // Given
        const request: PermissionRequest = {
            id: 'permission_interactive_bash',
            action: 'interactive_bash',
            reason: 'run tmux subcommand: new-session -d -s dev',
            permission: {
                kind: 'bash',
                patterns: ['new-session -d -s dev'],
                workspaceRoot: '/tmp/workspace',
            },
        };

        // When
        const decision = await createCliPermissionDecision(request);

        // Then
        expect(cliAllowsAction(request.action)).toBe(true);
        expect(decision.status).toBe('requires_approval');
    });

    it('denies shell.session while no production transport registration exists', async () => {
        // Given
        const request: PermissionRequest = {
            id: 'permission_shell_session',
            action: 'shell.session',
            reason: 'run shell.session: pwd',
            permission: {
                kind: 'bash',
                patterns: ['pwd'],
                workspaceRoot: '/tmp/workspace',
            },
        };

        // When
        const decision = await createCliPermissionDecision(request);

        // Then
        expect(cliAllowsAction(request.action)).toBe(false);
        expect(decision.status).toBe('deny');
    });
});

const allowPermission = async (request: { readonly id: string }) => ({
    requestId: request.id,
    status: 'allow' as const,
    reason: 'shell registration test',
});

function advertisedNames(production: ProductionToolRegistry): readonly string[] {
    return production.registry.advertise().map((advertisement) => advertisement.name);
}

async function prepareWorkspace(tempRoots: string[], prefix: string): Promise<string> {
    const configRoot = await mkdtemp(join(tmpdir(), `${prefix}config-`));
    const dataRoot = await mkdtemp(join(tmpdir(), `${prefix}data-`));
    const workspaceRoot = await mkdtemp(join(tmpdir(), `${prefix}workspace-`));
    tempRoots.push(configRoot, dataRoot, workspaceRoot);
    vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
    vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('PARALLEL_API_KEY', '');
    return workspaceRoot;
}
