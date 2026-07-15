import { AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { fileWriteToolCall, providerToolCallEvent } from '../desktop-tool-approval-test-support';
import { openLocalSessionEventStore } from './local-session-store';
import { tempDataDir } from './local-session-store-test-support';

const CREATED_AT = '2026-07-15T00:00:00.000Z';

describe('SQLite desktop tool proposal authority', () => {
    it('quarantines a tool call id when exact private arguments conflict', async () => {
        // Given: a real store receives two different proposals under one tool call identity.
        const dataDir = await tempDataDir('desktop-tool-proposal-conflict');
        const sessionId = 'session_desktop_tool_proposal_conflict';
        const toolCallId = 'call_desktop_tool_proposal_conflict';
        const first = fileWriteToolCall(toolCallId, 'first.txt', 'first', false);
        const substituted = fileWriteToolCall(toolCallId, 'second.txt', 'second', false);
        const store = await openLocalSessionEventStore({ dataDir, sessionId, now: () => CREATED_AT });

        // When: both provider proposals are appended to the durable event stream.
        await store.append(providerToolCallEvent(sessionId, first));
        await store.append(providerToolCallEvent(sessionId, substituted));
        const authority = await store.getDesktopApprovalToolCall(toolCallId);
        await store.close();

        // Then: neither proposal can become execution authority.
        expect(authority).toBeUndefined();
    });

    it('does not mint private execution authority from an imported envelope', async () => {
        // Given: an external archive envelope contains an otherwise valid provider tool proposal.
        const dataDir = await tempDataDir('desktop-tool-proposal-import');
        const sessionId = 'session_desktop_tool_proposal_import';
        const toolCall = fileWriteToolCall('call_desktop_tool_proposal_import', 'imported.txt', 'imported', false);
        const envelope = AgentEventEnvelopeSchema.parse({
            eventId: 'event_desktop_tool_proposal_import',
            sequence: 42,
            createdAt: CREATED_AT,
            sessionId,
            durability: 'durable',
            event: providerToolCallEvent(sessionId, toolCall),
        });
        const store = await openLocalSessionEventStore({ dataDir, sessionId, now: () => CREATED_AT });

        // When: the importer asks the store to assign its canonical sequence.
        await store.appendEnvelopeWithStoreSequence(envelope);
        const authority = await store.getDesktopApprovalToolCall(toolCall.toolCallId);
        await store.close();

        // Then: replay data remains visible without granting local effect authority.
        expect(authority).toBeUndefined();
    });
});
