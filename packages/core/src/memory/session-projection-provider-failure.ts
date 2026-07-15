import type { AgentEvent } from '@mission-control/protocol';
import type { CodingReplayStep } from '../session-replay-types';

type ProviderFailureStep = Extract<CodingReplayStep, { readonly kind: 'provider.failure' }>;

export function isProviderAbortedFailure(step: ProviderFailureStep, event: AgentEvent | undefined): boolean {
    if (step.error.code === 'provider_aborted') return true;
    const payload = event?.abg?.emit?.payload;
    if (!isPlainObject(payload)) return false;
    const { errorCode } = payload;
    return errorCode === 'provider_aborted';
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
