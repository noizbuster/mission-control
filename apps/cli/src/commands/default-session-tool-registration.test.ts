import { openLocalSessionEventStore } from '@mission-control/core';
import type { AgentEvent, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInteractiveToolRegistry } from './interactive-coding-tools';
import {
    fakeBroker,
    noLspServers,
    toolOptions,
    trustedProjectTrustStore,
} from './interactive-coding-tools-test-support';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { closeProductionToolRegistry, type ProductionToolRegistry } from './production-tool-registry';
import { createBufferedChatOutput } from './run-agent-chat-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_TOOL_NAMES = ['session_list', 'session_read', 'session_info', 'session_search'] as const;
const SESSION_ID = 'session_task_6_fixture';

describe('default session introspection tool registration', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises exactly the four read-class session tools in both production hosts', async () => {
        // Given
        const fixture = await prepareFixture(tempRoots);
        const permissionRequests: PermissionRequest[] = [];
        const requestPermission = permissionRecorder(permissionRequests);

        // When
        const pair = await createProductionRegistries(fixture, requestPermission);
        registries.push(...pair);

        // Then
        for (const production of pair) {
            const advertisements = sessionAdvertisements(production);
            expect(advertisements.map((advertisement) => advertisement.name)).toEqual(SESSION_TOOL_NAMES);
            expect(advertisements.map((advertisement) => advertisement.capabilityClasses)).toEqual([
                ['read'],
                ['read'],
                ['read'],
                ['read'],
            ]);
        }
        expect(permissionRequests).toEqual([]);
    });

    it('lists, reads, and searches durable data while returning the structured missing outcome without approval', async () => {
        // Given
        const fixture = await prepareFixture(tempRoots);
        await seedSession(fixture.dataDir);
        const permissionRequests: PermissionRequest[] = [];
        const pair = await createProductionRegistries(fixture, permissionRecorder(permissionRequests));
        registries.push(...pair);
        const [interactive, noninteractive] = pair;

        // When
        const [listed, searched, read, missing] = await Promise.all([
            invokeSessionTool(interactive, 'session_list', {}),
            invokeSessionTool(interactive, 'session_search', { query: 'introspection needle' }),
            invokeSessionTool(noninteractive, 'session_read', { session_id: SESSION_ID }),
            invokeSessionTool(noninteractive, 'session_read', { session_id: 'session_missing_task_6' }),
        ]);

        // Then
        expect(listed.structuredOutput).toMatchObject({ sessions: [{ sessionId: SESSION_ID }] });
        expect(searched.structuredOutput).toMatchObject({
            sessionsScanned: 1,
            results: expect.arrayContaining([
                expect.objectContaining({
                    sessionId: SESSION_ID,
                    excerpt: expect.stringContaining('introspection needle'),
                }),
            ]),
        });
        expect(read.structuredOutput).toMatchObject({
            sessionId: SESSION_ID,
            found: true,
            messages: [{ role: 'user' }, { role: 'assistant' }],
        });
        expect(missing.structuredOutput).toEqual({
            sessionId: 'session_missing_task_6',
            found: false,
            messages: [],
            truncated: false,
        });
        expect(permissionRequests).toEqual([]);
    });
});

type SessionToolFixture = {
    readonly dataDir: string;
    readonly workspaceRoot: string;
};

async function createProductionRegistries(
    fixture: SessionToolFixture,
    requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>,
): Promise<readonly [ProductionToolRegistry, ProductionToolRegistry]> {
    const output = createBufferedChatOutput();
    const interactive = await createInteractiveToolRegistry(
        {
            ...toolOptions(output.output, fixture.workspaceRoot),
            sessionTools: { dataDir: fixture.dataDir },
            lspServerManagerDeps: noLspServers,
        },
        { ...fakeBroker(), requestPermission },
    );
    const noninteractive = await createNonInteractiveToolRegistry({
        workspaceRoot: fixture.workspaceRoot,
        requestPermission,
        sessionTools: { dataDir: fixture.dataDir },
        projectTrustStore: trustedProjectTrustStore,
        lspServerManagerDeps: noLspServers,
    });
    return [interactive, noninteractive];
}

function sessionAdvertisements(production: ProductionToolRegistry) {
    return production.registry
        .advertise()
        .filter((advertisement) => SESSION_TOOL_NAMES.some((name) => name === advertisement.name));
}

function permissionRecorder(requests: PermissionRequest[]) {
    return async (request: PermissionRequest): Promise<PermissionDecision> => {
        requests.push(request);
        return {
            requestId: request.id,
            status: 'requires_approval',
            reason: 'session tools must not request approval',
        };
    };
}

async function invokeSessionTool(
    production: ProductionToolRegistry,
    toolName: (typeof SESSION_TOOL_NAMES)[number],
    input: Readonly<Record<string, unknown>>,
) {
    const advertisement = production.registry.advertise().find((candidate) => candidate.name === toolName);
    if (advertisement === undefined) throw new TypeError(`${toolName} was not advertised`);
    return production.registry.invoke({
        toolCallId: `${toolName}_task_6`,
        toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

async function prepareFixture(tempRoots: string[]): Promise<SessionToolFixture> {
    const configRoot = await mkdtemp(join(tmpdir(), 'mctrl-session-tools-config-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-session-tools-data-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-session-tools-workspace-'));
    tempRoots.push(configRoot, dataDir, workspaceRoot);
    vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
    vi.stubEnv('MCTRL_DATA_DIR', dataDir);
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('PARALLEL_API_KEY', '');
    return { dataDir, workspaceRoot };
}

async function seedSession(dataDir: string): Promise<void> {
    const events: readonly AgentEvent[] = [
        {
            type: 'run.command.received',
            timestamp: '2026-07-17T01:00:00.000Z',
            sessionId: SESSION_ID,
            message: 'find the introspection needle',
            run: { command: 'queue', state: 'running' },
        },
        {
            type: 'model.call.completed',
            timestamp: '2026-07-17T01:00:01.000Z',
            sessionId: SESSION_ID,
            taskId: 'turn_task_6',
            message: 'the introspection needle is visible',
            providerStreamChunk: {
                kind: 'response_completed',
                requestId: 'request_task_6',
                sequence: 1,
                message: {
                    messageId: 'message_task_6',
                    role: 'assistant',
                    content: 'the introspection needle is visible',
                },
                finishReason: 'stop',
            },
            transcript: {
                providerTurnId: 'turn_task_6',
                messageId: 'message_task_6',
                visibility: 'model_visible',
            },
        },
    ];
    const store = await openLocalSessionEventStore({ dataDir, sessionId: SESSION_ID });
    try {
        for (const event of events) await store.append(event);
    } finally {
        await store.close();
    }
}
