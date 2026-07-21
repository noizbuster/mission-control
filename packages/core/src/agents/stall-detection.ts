/**
 * Pure stall detection for running agents/jobs that have gone silent.
 * Used by the interactive `/kick` command to find targets whose connection
 * should be reset so work can continue.
 */

import type { BackgroundJobHandle } from './async-job-manager';
import type { AgentRef } from './runtime-registry';

/** Default silence window before a running target is considered stalled. */
export const DEFAULT_STALL_THRESHOLD_MS = 5 * 60 * 1000;

export type StalledAgentTarget = {
    readonly kind: 'agent';
    readonly id: string;
    readonly displayName: string;
    readonly sessionId: string;
    readonly lastActivity: string;
    readonly silentMs: number;
};

export type StalledJobTarget = {
    readonly kind: 'job';
    readonly jobId: string;
    readonly sessionId: string;
    readonly agentId?: string;
    readonly lastActivity: string;
    readonly silentMs: number;
};

export type StalledMainTurnTarget = {
    readonly kind: 'main_turn';
    readonly lastPacketAt: string;
    readonly silentMs: number;
};

export type StalledTarget = StalledAgentTarget | StalledJobTarget | StalledMainTurnTarget;

export type StallDetectionInput = {
    readonly agents?: readonly AgentRef[];
    readonly jobs?: readonly BackgroundJobHandle[];
    /** ISO timestamp of the last event packet on the foreground turn. */
    readonly mainLastPacketAt?: string;
    readonly nowMs?: number;
    readonly thresholdMs?: number;
};

/**
 * True when `lastActivityIso` is a valid ISO time at least `thresholdMs`
 * earlier than `nowMs`. Invalid timestamps are treated as not stalled.
 */
export function isSilentLongerThan(lastActivityIso: string, nowMs: number, thresholdMs: number): boolean {
    const activityMs = Date.parse(lastActivityIso);
    if (Number.isNaN(activityMs)) return false;
    return nowMs - activityMs >= thresholdMs;
}

/**
 * Collect running agents/jobs/main-turn targets that have been silent longer
 * than the threshold. Jobs without a matching agent use `startedAt` as the
 * activity clock (best available signal).
 */
export function findStalledTargets(input: StallDetectionInput): readonly StalledTarget[] {
    const nowMs = input.nowMs ?? Date.now();
    const thresholdMs = input.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    const agents = input.agents ?? [];
    const jobs = input.jobs ?? [];
    const agentBySession = new Map(agents.map((agent) => [agent.sessionId, agent] as const));
    const out: StalledTarget[] = [];

    if (input.mainLastPacketAt !== undefined && isSilentLongerThan(input.mainLastPacketAt, nowMs, thresholdMs)) {
        out.push({
            kind: 'main_turn',
            lastPacketAt: input.mainLastPacketAt,
            silentMs: nowMs - Date.parse(input.mainLastPacketAt),
        });
    }

    for (const agent of agents) {
        if (agent.status !== 'running') continue;
        if (!isSilentLongerThan(agent.lastActivity, nowMs, thresholdMs)) continue;
        out.push({
            kind: 'agent',
            id: agent.id,
            displayName: agent.displayName,
            sessionId: agent.sessionId,
            lastActivity: agent.lastActivity,
            silentMs: nowMs - Date.parse(agent.lastActivity),
        });
    }

    for (const job of jobs) {
        if (job.status !== 'running') continue;
        const matched = agentBySession.get(job.sessionId);
        const lastActivity = matched?.lastActivity ?? job.startedAt;
        if (!isSilentLongerThan(lastActivity, nowMs, thresholdMs)) continue;
        out.push({
            kind: 'job',
            jobId: job.jobId,
            sessionId: job.sessionId,
            ...(job.agentId !== undefined ? { agentId: job.agentId } : {}),
            lastActivity,
            silentMs: nowMs - Date.parse(lastActivity),
        });
    }

    return out;
}

export function formatSilentDuration(silentMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(silentMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remMin = minutes % 60;
        return `${hours}h ${remMin}m`;
    }
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}
