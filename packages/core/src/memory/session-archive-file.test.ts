import { describe, expect, it } from 'vitest';

describe('session archive file', () => {
    it('round trips a deterministic archive with a checksum-backed JSONL payload', async () => {
        // Given
        const module = await import(sessionArchiveModulePath);
        const archive = module.createSessionArchive({
            sessionId: 'session_archive_roundtrip',
            cwd: '/workspace/mission-control',
            trustedRoot: '/workspace/mission-control',
            createdAt: '2026-06-13T12:00:00.000Z',
            eventsJsonl: [
                '{"kind":"mission-control.session-log","version":1,"sessionId":"session_archive_roundtrip","createdAt":"2026-06-13T12:00:00.000Z"}',
                '',
            ].join('\n'),
        });

        // When
        const parsed = module.parseSessionArchive(JSON.stringify(archive));

        // Then
        expect(parsed.manifest.sessionId).toBe('session_archive_roundtrip');
        expect(parsed.eventsJsonl).toContain('"mission-control.session-log"');
    });

    it('rejects invalid archive schema versions and checksum mismatches', async () => {
        // Given
        const module = await import(sessionArchiveModulePath);
        const wrongVersion = JSON.stringify({
            kind: 'mission-control.session-archive',
            version: 99,
            manifest: {
                schemaVersion: 1,
                sessionId: 'session_archive_invalid',
                cwd: '/workspace/mission-control',
                trustedRoot: '/workspace/mission-control',
                createdAt: '2026-06-13T12:00:00.000Z',
            },
            checksum: { algorithm: 'sha256', value: 'bad' },
            eventsJsonl: '',
        });
        const checksumMismatch = JSON.stringify({
            kind: 'mission-control.session-archive',
            version: 1,
            manifest: {
                schemaVersion: 1,
                sessionId: 'session_archive_invalid',
                cwd: '/workspace/mission-control',
                trustedRoot: '/workspace/mission-control',
                createdAt: '2026-06-13T12:00:00.000Z',
            },
            checksum: { algorithm: 'sha256', value: 'bad' },
            eventsJsonl:
                '{"kind":"mission-control.session-log","version":1,"sessionId":"session_archive_invalid","createdAt":"2026-06-13T12:00:00.000Z"}\n',
        });

        expect(() => module.parseSessionArchive(wrongVersion)).toThrow();
        expect(() => module.parseSessionArchive(checksumMismatch)).toThrow();
    });

    it('rejects archive creation when the manifest session id is invalid', async () => {
        const module = await import(sessionArchiveModulePath);

        expect(() =>
            module.createSessionArchive({
                sessionId: '../escape',
                cwd: '/workspace/mission-control',
                trustedRoot: '/workspace/mission-control',
                createdAt: '2026-06-13T12:00:00.000Z',
                eventsJsonl:
                    '{"kind":"mission-control.session-log","version":1,"sessionId":"../escape","createdAt":"2026-06-13T12:00:00.000Z"}\n',
            }),
        ).toThrow();
    });
});

const sessionArchiveModulePath = './session-archive-file.js';
