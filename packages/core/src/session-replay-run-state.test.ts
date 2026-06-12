import { describe, it } from 'vitest';
import {
    expectBlockedApprovalAndResumedRunProjection,
    expectInterruptedAndFailedRunProjection,
} from './session-replay-run-state-test-support.js';

describe('session replay run state projections', () => {
    it('projects blocked approval and resumed run', () => {
        expectBlockedApprovalAndResumedRunProjection();
    });

    it('projects interrupted and failed run states distinctly', () => {
        expectInterruptedAndFailedRunProjection();
    });
});
