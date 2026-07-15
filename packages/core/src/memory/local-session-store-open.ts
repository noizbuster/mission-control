import type { AgentEventEnvelope, ToolCall } from '@mission-control/protocol';
import type {
    DesktopApprovalEffect,
    DesktopApprovalEffectClaimInput,
    DesktopApprovalEffectClaimResult,
    DesktopApprovalEffectRecord,
    DesktopApprovalEffectResolutionInput,
    DesktopApprovalEffectSettlementInput,
} from '../desktop-approval-effect.js';
import type { ObservabilityRedactor } from '../providers/observability-redactor.js';
import { resolveMissionControlDataDir } from './data-dir.js';
import type { JsonlSessionEventIdFactory } from './jsonl-session-event-store.js';
import { openEnsuredLocalSessionDatabase } from './local-session-store-database.js';
import { parseLocalSessionId } from './local-session-store-paths.js';
import type { MemoryStore } from './memory-store.js';
import { SqliteSessionEventStore } from './sqlite-session-event-store.js';

export type LocalSessionEventStore = MemoryStore & {
    readonly sessionId: string;
    appendEnvelope(envelope: AgentEventEnvelope): Promise<void>;
    appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void>;
    reserveDesktopApprovalEffect?(effect: DesktopApprovalEffect): Promise<boolean>;
    claimDesktopApprovalEffect?(input: DesktopApprovalEffectClaimInput): Promise<DesktopApprovalEffectClaimResult>;
    settleDesktopApprovalEffect?(input: DesktopApprovalEffectSettlementInput): Promise<boolean>;
    getDesktopApprovalEffect?(approvalId: string): Promise<DesktopApprovalEffectRecord | undefined>;
    getDesktopApprovalToolCall?(toolCallId: string): Promise<ToolCall | undefined>;
    resolveDesktopApprovalEffect?(
        input: DesktopApprovalEffectResolutionInput,
    ): Promise<DesktopApprovalEffectRecord | undefined>;
    close(): Promise<void> | void;
};

export type OpenLocalSessionEventStoreOptions = {
    readonly dataDir?: string;
    readonly sessionId: string;
    readonly now?: () => string;
    readonly createEventId?: JsonlSessionEventIdFactory;
    readonly observabilityRedactor?: ObservabilityRedactor;
};

export async function openLocalSessionEventStore(
    options: OpenLocalSessionEventStoreOptions,
): Promise<SqliteSessionEventStore> {
    const dataDir = options.dataDir ?? resolveMissionControlDataDir();
    const sessionId = parseLocalSessionId(options.sessionId);
    const now = options.now ?? (() => new Date().toISOString());
    const { runtime } = await openEnsuredLocalSessionDatabase({
        dataDir,
        now,
        ...(options.observabilityRedactor !== undefined
            ? { observabilityRedactor: options.observabilityRedactor }
            : {}),
    });
    try {
        const store = SqliteSessionEventStore.fromRuntime(runtime, {
            sessionId,
            now,
            ...(options.createEventId !== undefined ? { createEventId: options.createEventId } : {}),
            ...(options.observabilityRedactor !== undefined
                ? { observabilityRedactor: options.observabilityRedactor }
                : {}),
        });
        await store.recoverExpiredDesktopApprovalEffects();
        return store;
    } catch (error: unknown) {
        runtime.close();
        throw error;
    }
}
