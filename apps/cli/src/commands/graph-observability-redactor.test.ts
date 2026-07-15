import { createProviderAuthStore, McpConnectionManager, redactAgentEventForObservability } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGraphObservabilityRedactor } from './graph-observability-redactor.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('graph observability redactor wiring', () => {
    it('combines provider credentials with MCP literal environment and header secrets', async () => {
        // Given
        const root = await mkdtemp(join(tmpdir(), 'mission-control-graph-redactor-wiring-'));
        tempDirs.push(root);
        const authCredential = ['provider', 'field', 'credential'].join('_');
        const mcpEnvironmentCredential = ['mcp', 'literal', 'environment'].join('_');
        const mcpHeaderCredential = ['Bearer', 'mcp_literal_header'].join(' ');
        vi.stubEnv('MISSION_CONTROL_AUTH_FILE', join(root, 'auth.json'));
        const authStore = createProviderAuthStore();
        await authStore.saveCredential({
            providerID: 'custom-provider',
            modelID: 'custom-model',
            now: '2026-07-13T00:00:00.000Z',
            fields: [{ id: 'CUSTOM_SECRET', value: authCredential, secret: true }],
        });
        const userConfigPath = join(root, 'config.json');
        const projectConfigPath = join(root, '.mcp.json');
        await writeFile(
            userConfigPath,
            JSON.stringify({
                mcp: {
                    local: {
                        type: 'local',
                        enabled: false,
                        command: ['unused'],
                        environment: { API_TOKEN: mcpEnvironmentCredential },
                    },
                    remote: {
                        type: 'remote',
                        enabled: false,
                        url: 'https://mcp.example.test',
                        headers: { Authorization: mcpHeaderCredential },
                    },
                },
            }),
        );
        const manager = new McpConnectionManager();
        await manager.connectAll({
            workspaceRoot: root,
            projectTrustDecision: 'trusted',
            userConfigPath,
            projectConfigPath,
            env: {},
        });

        // When
        const redactor = await createGraphObservabilityRedactor({ authStore, mcpConnectionManager: manager });
        const observable = JSON.stringify(
            redactor.redactValue({
                provider: authCredential,
                nested: [{ environment: mcpEnvironmentCredential }, { header: mcpHeaderCredential }],
                ordinary: 'keep-this-value',
            }),
        );
        const approvalObservable = JSON.stringify(
            redactAgentEventForObservability(
                {
                    type: 'permission.requested',
                    timestamp: '2026-07-13T00:00:00.000Z',
                    permissionRequest: {
                        id: 'permission_composed_redactor',
                        action: 'command.run',
                        reason: `run ${authCredential}`,
                        permission: {
                            kind: 'bash',
                            patterns: [`node --token ${mcpEnvironmentCredential}`],
                            workspaceRoot: `/workspace/${mcpHeaderCredential}`,
                        },
                    },
                    permissionDecision: {
                        requestId: 'permission_composed_redactor',
                        status: 'requires_approval',
                        reason: `matched ${authCredential}`,
                    },
                },
                redactor,
            ),
        );

        // Then
        expect(observable.includes('[REDACTED_CREDENTIAL]')).toBe(true);
        expect(observable.includes('keep-this-value')).toBe(true);
        for (const secret of [authCredential, mcpEnvironmentCredential, mcpHeaderCredential]) {
            expect(observable.includes(secret)).toBe(false);
            expect(approvalObservable.includes(secret)).toBe(false);
        }
    });
});
