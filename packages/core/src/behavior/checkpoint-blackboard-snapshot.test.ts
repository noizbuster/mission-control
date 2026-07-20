import { describe, expect, it } from 'vitest';
import { REDACTED_CREDENTIAL } from '../providers/redaction-handler';
import { buildCheckpointBlackboardEntries } from './checkpoint-blackboard-snapshot';

describe('buildCheckpointBlackboardEntries', () => {
    it('keeps plan.ready boolean routing state', () => {
        // Given
        const record: Readonly<Record<string, unknown>> = {
            'plan.ready': true,
        };

        // When
        const snapshot = buildCheckpointBlackboardEntries(record);

        // Then
        expect(snapshot).toEqual({ 'plan.ready': true });
    });

    it('omits turn-local LLM loop flags', () => {
        // Given
        const record: Readonly<Record<string, unknown>> = {
            'llm.loop_active': true,
            'llm.soft_landed': true,
            'final.verdict': 'APPROVE',
        };

        // When
        const snapshot = buildCheckpointBlackboardEntries(record);

        // Then
        expect(snapshot).toEqual({ 'final.verdict': 'APPROVE' });
    });

    it('redacts secret-shaped strings while preserving string routing enums', () => {
        // Given
        const fakeApiKey = 'sk-checkpointSecret123';
        const record: Readonly<Record<string, unknown>> = {
            'intent.classification': 'explicit-implementation',
            'provider.api_key': fakeApiKey,
        };

        // When
        const snapshot = buildCheckpointBlackboardEntries(record);

        // Then
        expect(snapshot).toEqual({
            'intent.classification': 'explicit-implementation',
            'provider.api_key': REDACTED_CREDENTIAL,
        });
    });

    it('keeps nested routing objects intact', () => {
        // Given
        const delegateResults = {
            nextTaskLabel: '4. Checkpoint BB snapshot policy',
            items: [{ id: 'task-4', ready: false }],
            verdicts: { constraints: 'APPROVE', tests: 'REJECT' },
        };
        const record: Readonly<Record<string, unknown>> = {
            'delegate.results': delegateResults,
            'plan.todos': [{ label: 'task-4', checked: false }],
        };

        // When
        const snapshot = buildCheckpointBlackboardEntries(record);

        // Then
        expect(snapshot).toEqual({
            'delegate.results': delegateResults,
            'plan.todos': [{ label: 'task-4', checked: false }],
        });
    });
});
