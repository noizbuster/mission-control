import type { ProjectTrustLookup } from '@mission-control/core';
import { ProjectTrustStore } from '@mission-control/core';
import type { TrustCommandAction } from './chat-commands.js';
import type { ChatOutput } from './interactive-chat-io.js';

export async function runTrustAction(
    chatOutput: ChatOutput,
    action: TrustCommandAction,
    workspaceRoot: string,
): Promise<void> {
    try {
        await runTrustActionUnsafe(chatOutput, action, workspaceRoot);
    } catch (error: unknown) {
        chatOutput.write(`Trust command failed: ${errorMessage(error)}\n`);
    }
}

async function runTrustActionUnsafe(
    chatOutput: ChatOutput,
    action: TrustCommandAction,
    workspaceRoot: string,
): Promise<void> {
    const store = new ProjectTrustStore();
    switch (action) {
        case 'status': {
            const status = await store.getDecision(workspaceRoot);
            chatOutput.write(
                `Trust status for ${status.workspaceRoot}: ${status.decision}${formatStoreState(status)}\n`,
            );
            return;
        }
        case 'trust': {
            const trusted = await store.setDecision(workspaceRoot, 'trusted');
            chatOutput.write(`Trusted project: ${trusted.workspaceRoot}\n`);
            return;
        }
        case 'deny': {
            const denied = await store.setDecision(workspaceRoot, 'denied');
            chatOutput.write(`Denied project: ${denied.workspaceRoot}\n`);
            return;
        }
        case 'reset': {
            const reset = await store.resetDecision(workspaceRoot);
            chatOutput.write(`Reset project trust: ${reset.workspaceRoot}\n`);
            return;
        }
        default:
            return assertNever(action);
    }
}

function formatStoreState(status: ProjectTrustLookup): string {
    switch (status.storeState) {
        case 'missing':
        case 'valid':
            return '';
        case 'corrupt':
            return ' (trust store corrupt; using the pending-review decision)';
        default:
            return assertNever(status.storeState);
    }
}

function assertNever(value: never): never {
    throw new Error(`Unexpected trust command state: ${String(value)}`);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
