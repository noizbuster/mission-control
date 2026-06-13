import { type AgentEventEnvelope, AgentEventEnvelopeSchema, type AgentEventType } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { projectJsonlSessionReplayPrefix, projectSessionReplay } from '../session-replay.js';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    serializeJsonlRecord,
} from './jsonl-session-records.js';
import {
    SessionArchiveValidationError,
    validateSessionArchiveManifestForImport,
} from './session-archive-validation.js';

const SESSION_ID = 'session_tree_projection';
const CREATED_AT = '2026-06-13T01:00:00.000Z';
const ARCHIVE_MANIFEST = {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    cwd: '/workspace/mission-control',
    trustedRoot: '/workspace/mission-control',
    createdAt: '2026-06-13T01:00:03.000Z',
};

describe('session tree projection', () => {
    it('projects linear and branched entries from durable JSONL envelopes', () => {
        // Given
        const envelopes = [
            envelope({
                eventId: 'event_root',
                sequence: 0,
                message: 'root prompt',
                sessionTree: { kind: 'entry', entryId: 'entry_root' },
            }),
            envelope({
                eventId: 'event_linear',
                sequence: 1,
                message: 'linear reply',
                sessionTree: { kind: 'entry', entryId: 'entry_linear', parentEntryId: 'entry_root' },
            }),
            envelope({
                eventId: 'event_branch',
                sequence: 2,
                message: 'branch reply',
                sessionTree: { kind: 'entry', entryId: 'entry_branch', parentEntryId: 'entry_root', active: true },
            }),
        ];

        // When
        const replay = projectSessionReplay({ sessionId: SESSION_ID, envelopes });

        // Then
        expect(replay.sessionTree).toMatchObject({
            sessionId: SESSION_ID,
            activeLeafId: 'entry_branch',
            nodes: expect.arrayContaining([
                expect.objectContaining({
                    entryId: 'entry_root',
                    childEntryIds: ['entry_linear', 'entry_branch'],
                }),
                expect.objectContaining({
                    entryId: 'entry_branch',
                    parentEntryId: 'entry_root',
                    message: 'branch reply',
                }),
            ]),
        });
    });

    it('projects session metadata plus fork and clone sources', () => {
        // Given
        const envelopes = [
            envelope({
                eventId: 'event_metadata',
                sequence: 0,
                eventType: 'session.started',
                message: 'started named child',
                sessionTree: {
                    kind: 'metadata',
                    name: 'Investigate parser failure',
                    parentSessionId: 'session_parent',
                },
            }),
            envelope({
                eventId: 'event_fork',
                sequence: 1,
                sessionTree: {
                    kind: 'fork',
                    parentSessionId: 'session_parent',
                    source: { sessionId: 'session_parent', entryId: 'entry_parent_leaf' },
                },
            }),
            envelope({
                eventId: 'event_clone',
                sequence: 2,
                sessionTree: {
                    kind: 'clone',
                    source: { sessionId: 'session_template', entryId: 'entry_template_leaf' },
                },
            }),
        ];

        // When
        const replay = projectSessionReplay({ sessionId: SESSION_ID, envelopes });

        // Then
        expect(replay.sessionTree).toMatchObject({
            sessionName: 'Investigate parser failure',
            parentSessionId: 'session_parent',
            forkSource: { sessionId: 'session_parent', entryId: 'entry_parent_leaf' },
            cloneSource: { sessionId: 'session_template', entryId: 'entry_template_leaf' },
        });
    });

    it('projects compaction and import/export metadata without replacing JSONL records', () => {
        // Given
        const manifest = ARCHIVE_MANIFEST;
        const envelopes = [
            envelope({
                eventId: 'event_root',
                sequence: 0,
                sessionTree: { kind: 'entry', entryId: 'entry_root' },
            }),
            envelope({
                eventId: 'event_compaction',
                sequence: 1,
                sessionTree: {
                    kind: 'compaction',
                    boundaryEntryId: 'entry_root',
                    firstKeptEntryId: 'entry_root',
                    summary: 'kept root only',
                },
            }),
            envelope({
                eventId: 'event_export',
                sequence: 2,
                sessionTree: { kind: 'export', manifest },
            }),
            envelope({
                eventId: 'event_import',
                sequence: 3,
                sessionTree: {
                    kind: 'import',
                    manifest,
                    sourceSessionId: 'session_import_source',
                },
            }),
        ];

        // When
        const replay = projectSessionReplay({ sessionId: SESSION_ID, envelopes });

        // Then
        expect(replay.sessionTree).toMatchObject({
            compactionBoundaries: [
                expect.objectContaining({
                    boundaryEntryId: 'entry_root',
                    firstKeptEntryId: 'entry_root',
                    summary: 'kept root only',
                }),
            ],
            exports: [expect.objectContaining({ manifest })],
            imports: [
                expect.objectContaining({
                    manifest,
                    sourceSessionId: 'session_import_source',
                }),
            ],
        });
    });

    it('projects the safe prefix when corrupt ordering appears after session tree entries', () => {
        // Given
        const contents = [
            serializeJsonlRecord(createJsonlSessionLogHeader({ sessionId: SESSION_ID, createdAt: CREATED_AT })),
            eventRecord({
                eventId: 'event_root',
                sequence: 0,
                sessionTree: { kind: 'entry', entryId: 'entry_root' },
            }),
            eventRecord({
                eventId: 'event_prefix_leaf',
                sequence: 2,
                sessionTree: {
                    kind: 'entry',
                    entryId: 'entry_prefix_leaf',
                    parentEntryId: 'entry_root',
                    active: true,
                },
            }),
            eventRecord({
                eventId: 'event_corrupt_order',
                sequence: 1,
                sessionTree: {
                    kind: 'entry',
                    entryId: 'entry_corrupt_order',
                    parentEntryId: 'entry_root',
                },
            }),
        ].join('');

        // When
        const replay = projectJsonlSessionReplayPrefix({ sessionId: SESSION_ID, contents });

        // Then
        expect(replay.diagnostics).toEqual([{ code: 'corrupt_trailing_record', lineNumber: 4, sessionId: SESSION_ID }]);
        expect(replay.projection.sessionTree).toMatchObject({
            activeLeafId: 'entry_prefix_leaf',
            nodes: expect.arrayContaining([
                expect.objectContaining({
                    entryId: 'entry_root',
                    childEntryIds: ['entry_prefix_leaf'],
                }),
            ]),
        });
    });

    it('keeps the explicit active leaf when later non-tree lifecycle events are appended', () => {
        // Given
        const envelopes = [
            envelope({
                eventId: 'event_started',
                sequence: 0,
                eventType: 'session.started',
                message: 'started',
            }),
            envelope({
                eventId: 'event_branch',
                sequence: 1,
                message: 'branch reply',
                sessionTree: { kind: 'entry', entryId: 'entry_branch', active: true },
            }),
            envelope({
                eventId: 'event_stopped',
                sequence: 2,
                eventType: 'session.stopped',
                message: 'stopped',
            }),
        ];

        // When
        const replay = projectSessionReplay({ sessionId: SESSION_ID, envelopes });

        // Then
        expect(replay.sessionTree.activeLeafId).toBe('entry_branch');
        expect(replay.sessionTree.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ entryId: 'event_started' }),
                expect.objectContaining({ entryId: 'entry_branch' }),
                expect.objectContaining({ entryId: 'event_stopped' }),
            ]),
        );
    });

    it('validates import manifests against session id, schema version, cwd, and trusted root', () => {
        // Given
        const manifest = ARCHIVE_MANIFEST;

        // When
        const validated = validateArchiveManifest(manifest);
        const invalidCases = [
            { manifest: { ...manifest, sessionId: 'session_other' }, code: 'session_mismatch' },
            { manifest: { ...manifest, schemaVersion: 2 }, code: 'unsupported_schema_version' },
            { manifest: { ...manifest, createdAt: 'not-a-date' }, code: 'invalid_manifest' },
            { manifest: { ...manifest, cwd: '/workspace/other' }, code: 'cwd_mismatch' },
            { manifest: { ...manifest, trustedRoot: '/workspace/other' }, code: 'trusted_root_mismatch' },
        ] as const;

        // Then
        expect(validated).toEqual(manifest);
        for (const invalidCase of invalidCases) {
            const validate = () => validateArchiveManifest(invalidCase.manifest);
            expect(validate).toThrow(
                expect.objectContaining({ code: invalidCase.code, name: 'SessionArchiveValidationError' }),
            );
            expect(validate).toThrow(SessionArchiveValidationError);
        }
    });
});

type EnvelopeInput = {
    readonly eventId: string;
    readonly sequence: number;
    readonly eventType?: AgentEventType;
    readonly message?: string;
    readonly sessionTree?: Record<string, unknown>;
};

function envelope(input: EnvelopeInput): AgentEventEnvelope {
    return AgentEventEnvelopeSchema.parse({
        eventId: input.eventId,
        sequence: input.sequence,
        createdAt: timestampForSequence(input.sequence),
        sessionId: SESSION_ID,
        durability: 'durable',
        event: {
            type: input.eventType ?? 'task.completed',
            timestamp: timestampForSequence(input.sequence),
            sessionId: SESSION_ID,
            taskId: `task_${input.sequence}`,
            nativeSidecarStatus: 'mock',
            ...(input.message !== undefined ? { message: input.message } : {}),
            ...(input.sessionTree !== undefined ? { sessionTree: input.sessionTree } : {}),
        },
    });
}

function eventRecord(input: EnvelopeInput): string {
    return serializeJsonlRecord(createJsonlSessionEventRecord(envelope(input)));
}

function validateArchiveManifest(manifest: unknown): unknown {
    return validateSessionArchiveManifestForImport({
        manifest,
        expectedSessionId: SESSION_ID,
        expectedCwd: '/workspace/mission-control',
        trustedRoot: '/workspace/mission-control',
    });
}

function timestampForSequence(sequence: number): string {
    return `2026-06-13T01:00:0${sequence}.000Z`;
}
