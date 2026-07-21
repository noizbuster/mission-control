import {
    DEFAULT_STALL_THRESHOLD_MS,
    findStalledTargets,
    formatSilentDuration,
    type StalledTarget,
} from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { CodingActionContext } from './interactive-chat-action-context';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result';
import type { ChatOutput } from './interactive-chat-io';
import { runWorkResumeAction } from './interactive-workflow-resume-actions';

export const KICK_CANCEL_REASON = 'kicked_stale_no_packets';

export async function runKickAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    const services = coding.taskRuntimeServices;
    const agents = services?.runtimeRegistry.listAll() ?? [];
    const jobs = services?.jobManager.listJobs() ?? [];
    const mainLastPacketAt = coding.activeTurn?.lastPacketAt();
    const stalled = findStalledTargets({
        agents,
        jobs,
        ...(mainLastPacketAt !== undefined ? { mainLastPacketAt } : {}),
        thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
    });

    if (stalled.length === 0) {
        chatOutput.write(
            `No stalled running agents or jobs (silence threshold ${formatSilentDuration(DEFAULT_STALL_THRESHOLD_MS)}).\n`,
        );
        return actionResult(selection, coding.activeTurn);
    }

    chatOutput.write(`Kicking ${stalled.length} stalled target(s):\n`);
    for (const target of stalled) {
        chatOutput.write(`  - ${formatStalledTargetLine(target)}\n`);
    }

    const jobIds = new Set(
        stalled.filter((t): t is Extract<StalledTarget, { kind: 'job' }> => t.kind === 'job').map((t) => t.jobId),
    );
    for (const jobId of jobIds) {
        services?.jobManager.cancelJob(jobId, KICK_CANCEL_REASON);
    }

    const agentIds = stalled
        .filter((t): t is Extract<StalledTarget, { kind: 'agent' }> => t.kind === 'agent')
        .map((t) => t.id);
    for (const agentId of agentIds) {
        services?.runtimeRegistry.update(agentId, { status: 'aborted', activity: KICK_CANCEL_REASON });
    }

    const mainStalled = stalled.some((t) => t.kind === 'main_turn');
    let activeTurn = coding.activeTurn;
    if (mainStalled && activeTurn !== undefined) {
        chatOutput.write('Resetting foreground connection (interrupt stalled turn)…\n');
        activeTurn.interrupt('force');
        await activeTurn.done;
        activeTurn = undefined;
        chatOutput.write('Attempting resume from checkpoint…\n');
        return runWorkResumeAction(chatOutput, selection, { ...coding, activeTurn: undefined });
    }

    chatOutput.write(
        jobIds.size > 0
            ? `Cancelled ${jobIds.size} job(s). Parent turns may settle or retry with a fresh connection.\n`
            : 'Stalled agent refs marked aborted.\n',
    );
    return actionResult(selection, activeTurn);
}

function formatStalledTargetLine(target: StalledTarget): string {
    const silent = formatSilentDuration(target.silentMs);
    switch (target.kind) {
        case 'main_turn':
            return `main turn silent ${silent} (last packet ${target.lastPacketAt})`;
        case 'agent':
            return `agent ${target.displayName} (${target.id}) silent ${silent}`;
        case 'job':
            return `job ${target.jobId} silent ${silent}`;
        default: {
            const _exhaustive: never = target;
            return String(_exhaustive);
        }
    }
}
