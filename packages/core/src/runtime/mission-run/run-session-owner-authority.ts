import { type Run, RunSchema } from '@mission-control/protocol';

export function runWithoutSessionOwnerAuthority(run: Run): Run {
    const { sessionRunId: _sessionRunId, ...unownedRun } = RunSchema.parse(run);
    return RunSchema.parse(unownedRun);
}
