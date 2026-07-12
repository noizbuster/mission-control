import {
    approvalIdForToolCall,
    codingAgentSmokeSelection,
    createSmokeApprovalEventId,
    fixedCodingAgentSmokeNow,
    type SmokeApprovalDependencies,
} from './coding-agent-smoke-shared.ts';

export async function approvePendingSmokePatch(
    input: {
        readonly dataDir: string;
        readonly sessionId: string;
        readonly workspaceRoot: string;
        readonly toolCallId: string;
    },
    dependencies: SmokeApprovalDependencies,
): Promise<void> {
    const store = await dependencies.openStore({
        dataDir: input.dataDir,
        sessionId: input.sessionId,
        now: fixedCodingAgentSmokeNow,
        createEventId: createSmokeApprovalEventId,
    });
    try {
        await dependencies.ensurePendingApproval({
            store,
            sessionId: input.sessionId,
            modelProviderSelection: codingAgentSmokeSelection,
            now: fixedCodingAgentSmokeNow,
            blockedToolCallId: input.toolCallId,
        });
        const status = await dependencies.settleApproval(
            {
                sessionId: input.sessionId,
                approvalId: approvalIdForToolCall(input.toolCallId),
                state: 'approved',
                reason: 'approved for smoke resume',
            },
            {
                store,
                sessionId: input.sessionId,
                workspaceRoot: input.workspaceRoot,
                modelProviderSelection: codingAgentSmokeSelection,
                now: fixedCodingAgentSmokeNow,
            },
        );
        if (status !== 'completed') {
            throw new Error(`expected completed approval settlement, received ${status}`);
        }
    } finally {
        await store.close();
    }
}
