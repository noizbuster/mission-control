import type { SeparatorState } from '../components/Separator.js';

type SeparatorStateSnapshot = {
    readonly generating: boolean;
    readonly approvalActive: boolean;
    readonly questionActive: boolean;
};

export function resolveSeparatorState(snapshot: SeparatorStateSnapshot): SeparatorState {
    if (snapshot.generating) {
        return 'running';
    }
    if (snapshot.approvalActive || snapshot.questionActive) {
        return 'awaiting_input';
    }
    return 'idle';
}
