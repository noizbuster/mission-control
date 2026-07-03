import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    serializeJsonlRecord,
} from '../memory/jsonl-session-records.js';
import { createSessionInfoToolRegistration, formatSessionInfoModelOutput } from './session-info-tool.js';
import { createSessionListToolRegistration, formatSessionListModelOutput } from './session-list-tool.js';
import { createSessionReadToolRegistration, formatSessionReadModelOutput } from './session-read-tool.js';
import { createSessionSearchToolRegistration, formatSessionSearchModelOutput } from './session-search-tool.js';
import { MAX_SESSIONS_TO_SCAN, SESSION_REDACTED, SESSION_SEARCH_TIMEOUT_MS } from './session-tools-shared.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolExecutionContext } from './tool-registry-types.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const neverAbort = new AbortController().signal;
const fixtureContext: ToolExecutionContext = { toolCallId: 'call_test', toolName: 'session_test', signal: neverAbort };

describe('session_* tools over durable JSONL sessions', () => {
    it('list/read/search/info against fixture sessions', async () => {
        const dataDir = await freshDataDir();
        await writeSession(dataDir, 'ses_alpha', [
            userPromptEvent('ses_alpha', 'plan the authentication refactor', '2026-07-01T10:00:00.000Z'),
            assistantEvent(
                'ses_alpha',
                'turn_a',
                'I will plan the authentication refactor now.',
                '2026-07-01T10:00:05.000Z',
            ),
            userPromptEvent('ses_alpha', 'ship it', '2026-07-01T11:00:00.000Z'),
            assistantEvent('ses_alpha', 'turn_b', 'Shipping the authentication refactor.', '2026-07-01T11:00:30.000Z'),
        ]);
        await writeSession(dataDir, 'ses_beta', [
            userPromptEvent('ses_beta', 'review the database migration', '2026-07-02T09:00:00.000Z'),
            assistantEvent('ses_beta', 'turn_c', 'The database migration looks safe.', '2026-07-02T09:00:10.000Z'),
        ]);

        const list = createSessionListToolRegistration({ dataDir });
        const listOutput = await list.execute({}, fixtureContext);
        expect(listOutput.sessions.map((session) => session.sessionId).sort()).toEqual(['ses_alpha', 'ses_beta']);
        expect(listOutput.sessions[0]?.messageCount).toBeGreaterThan(0);

        // limit truncates
        const limited = await list.execute({ limit: 1 }, fixtureContext);
        expect(limited.sessions.length).toBe(1);
        expect(limited.truncated).toBe(true);

        // date filter excludes older sessions
        const filtered = await list.execute({ from_date: '2026-07-02T00:00:00.000Z' }, fixtureContext);
        expect(filtered.sessions.map((session) => session.sessionId)).toEqual(['ses_beta']);

        // read returns ordered turns
        const read = createSessionReadToolRegistration({ dataDir });
        const readOutput = await read.execute({ session_id: 'ses_alpha' }, fixtureContext);
        expect(readOutput.found).toBe(true);
        expect(readOutput.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(readOutput.messages[0]?.text).toContain('plan the authentication refactor');

        // from_end returns the tail
        const tail = await read.execute({ session_id: 'ses_alpha', limit: 1, from_end: true }, fixtureContext);
        expect(tail.messages.length).toBe(1);
        expect(tail.messages[0]?.text).toContain('Shipping the authentication refactor');

        // missing session
        const missing = await read.execute({ session_id: 'ses_missing' }, fixtureContext);
        expect(missing.found).toBe(false);

        // search across sessions
        const search = createSessionSearchToolRegistration({ dataDir });
        const searchOutput = await search.execute({ query: 'authentication' }, fixtureContext);
        expect(searchOutput.results.length).toBeGreaterThan(0);
        expect(searchOutput.results.every((result) => result.excerpt.toLowerCase().includes('authentication'))).toBe(
            true,
        );

        // search within one session (both the user and assistant message mention "database")
        const scoped = await search.execute({ query: 'database', session_id: 'ses_beta' }, fixtureContext);
        expect(scoped.results.length).toBe(2);
        expect(scoped.results.every((result) => result.sessionId === 'ses_beta')).toBe(true);
        // and it does not bleed into the other session
        const scopedMiss = await search.execute({ query: 'database', session_id: 'ses_alpha' }, fixtureContext);
        expect(scopedMiss.results.length).toBe(0);

        // search case sensitivity
        const caseSensitive = await search.execute({ query: 'Shipping', case_sensitive: true }, fixtureContext);
        expect(caseSensitive.results.some((result) => result.messageId.includes('turn_b'))).toBe(true);
        const caseInsensitive = await search.execute({ query: 'shipping', case_sensitive: false }, fixtureContext);
        expect(caseInsensitive.results.some((result) => result.messageId.includes('turn_b'))).toBe(true);

        // info returns summary fields
        const info = createSessionInfoToolRegistration({ dataDir });
        const infoOutput = await info.execute({ session_id: 'ses_beta' }, fixtureContext);
        expect(infoOutput.found).toBe(true);
        expect(infoOutput.eventCount).toBeGreaterThan(0);
        expect(infoOutput.messageCount).toBe(1);
    });

    it('redacts raw API keys from read + search output', async () => {
        const dataDir = await freshDataDir();
        const leakedKey = 'sk-leaked-9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d';
        await writeSession(dataDir, 'ses_secret', [
            userPromptEvent('ses_secret', 'check this token', '2026-07-03T08:00:00.000Z'),
            assistantEvent(
                'ses_secret',
                'turn_secret',
                `Sure, the key ${leakedKey} is configured for the provider.`,
                '2026-07-03T08:00:05.000Z',
            ),
        ]);

        const read = createSessionReadToolRegistration({ dataDir });
        const readOutput = await read.execute({ session_id: 'ses_secret' }, fixtureContext);
        const readText = formatSessionReadModelOutput(readOutput);
        expect(readText).not.toContain(leakedKey);
        expect(readText).toContain(SESSION_REDACTED);
        expect(readOutput.messages.every((message) => !message.text.includes(leakedKey))).toBe(true);

        const search = createSessionSearchToolRegistration({ dataDir });
        const searchOutput = await search.execute({ query: 'token' }, fixtureContext);
        const searchText = formatSessionSearchModelOutput(searchOutput);
        expect(searchText).not.toContain(leakedKey);
        expect(searchOutput.results.every((result) => !result.excerpt.includes(leakedKey))).toBe(true);
    });

    it('session_search is bounded by the 50-session scan cap and 60s timeout constant', async () => {
        const dataDir = await freshDataDir();
        // Create more sessions than the cap to prove scanning stops at MAX_SESSIONS_TO_SCAN.
        const total = MAX_SESSIONS_TO_SCAN + 10;
        for (let index = 0; index < total; index += 1) {
            const id = `ses_cap_${index.toString().padStart(3, '0')}`;
            await writeSession(dataDir, id, [
                userPromptEvent(id, `bounded search probe ${index}`, '2026-07-03T08:00:00.000Z'),
            ]);
        }
        const search = createSessionSearchToolRegistration({ dataDir });
        const output = await search.execute({ query: 'bounded', limit: 100 }, fixtureContext);
        expect(output.sessionsScanned).toBe(MAX_SESSIONS_TO_SCAN);
        expect(output.timedOut).toBe(false);

        // The caps are part of the contract.
        expect(SESSION_SEARCH_TIMEOUT_MS).toBe(60_000);
        expect(MAX_SESSIONS_TO_SCAN).toBe(50);
    });

    it('registers and invokes through ToolRegistry with read capability', async () => {
        const dataDir = await freshDataDir();
        await writeSession(dataDir, 'ses_registry', [
            userPromptEvent('ses_registry', 'registry probe', '2026-07-03T08:00:00.000Z'),
            assistantEvent('ses_registry', 'turn_reg', 'registry acknowledged', '2026-07-03T08:00:05.000Z'),
        ]);
        const registry = new ToolRegistry();
        registerAll(registry, dataDir);

        const advertisements = registry.advertise();
        const names = advertisements.map((ad) => ad.name).sort();
        expect(names).toEqual(['session_info', 'session_list', 'session_read', 'session_search']);
        for (const ad of advertisements) {
            expect(ad.capabilityClasses).toContain('read');
        }

        const settlement = await registry.invoke({
            toolName: 'session_read',
            toolCallId: 'call_invoke',
            advertisedVersion: versionOf(registry, 'session_read'),
            argumentsJson: JSON.stringify({ session_id: 'ses_registry' }),
        });
        expect(settlement.result.status).toBe('completed');
        expect(settlement.modelOutput?.content).toContain('registry acknowledged');
    });
});

function registerAll(registry: ToolRegistry, dataDir: string): void {
    registry.register(createSessionListToolRegistration({ dataDir }));
    registry.register(createSessionReadToolRegistration({ dataDir }));
    registry.register(createSessionSearchToolRegistration({ dataDir }));
    registry.register(createSessionInfoToolRegistration({ dataDir }));
}

function versionOf(registry: ToolRegistry, name: string): string {
    const ad = registry.advertise().find((entry) => entry.name === name);
    if (ad === undefined) {
        throw new Error(`missing advertisement for ${name}`);
    }
    return ad.version;
}

async function freshDataDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'mctrl-session-tools-'));
}

async function writeSession(dataDir: string, sessionId: string, events: readonly AgentEvent[]): Promise<void> {
    const sessionsDir = join(dataDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const lines: string[] = [
        serializeJsonlRecord(
            createJsonlSessionLogHeader({ sessionId, createdAt: events[0]?.timestamp ?? '2026-07-01T00:00:00.000Z' }),
        ),
    ];
    events.forEach((event, index) => {
        const envelope: AgentEventEnvelope = {
            eventId: `evt_${sessionId}_${index}`,
            sequence: index,
            createdAt: event.timestamp,
            sessionId,
            durability: 'durable',
            event,
        };
        lines.push(serializeJsonlRecord(createJsonlSessionEventRecord(envelope)));
    });
    await writeFile(join(sessionsDir, `${sessionId}.jsonl`), lines.join(''), 'utf8');
}

function userPromptEvent(sessionId: string, prompt: string, timestamp: string): AgentEvent {
    return {
        type: 'run.command.received',
        timestamp,
        sessionId,
        message: prompt,
        run: { command: 'queue', state: 'running' },
    };
}

function assistantEvent(sessionId: string, providerTurnId: string, content: string, timestamp: string): AgentEvent {
    return {
        type: 'model.call.completed',
        timestamp,
        sessionId,
        taskId: providerTurnId,
        message: content,
        providerStreamChunk: {
            kind: 'response_completed',
            requestId: `request_${providerTurnId}`,
            sequence: 2,
            message: {
                messageId: `message_${providerTurnId}`,
                role: 'assistant',
                content,
            },
            finishReason: 'stop',
        },
        transcript: {
            providerTurnId,
            messageId: `message_${providerTurnId}`,
            visibility: 'model_visible',
        },
    };
}
