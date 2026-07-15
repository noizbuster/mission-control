import type { ModelProviderSelection } from '@mission-control/protocol';
import { APPROVAL_LEVEL_META, type ApprovalLevel } from '@mission-control/tui/state';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { ChatOutput } from './interactive-chat-io.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';

export async function runApprovalAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    requestedLevel: ApprovalLevel | undefined,
    activeTurn: ActiveCodingAgentTurn | undefined,
    currentLevel: ApprovalLevel | undefined,
    selectApprovalLevel?: (currentLevel?: ApprovalLevel) => Promise<ApprovalLevel | undefined>,
): Promise<ChatActionResult> {
    const selected =
        requestedLevel ?? (selectApprovalLevel === undefined ? undefined : await selectApprovalLevel(currentLevel));
    if (selected !== undefined) {
        activeTurn?.setApprovalLevel(selected);
        const applied = activeTurn !== undefined ? ' (applied to active run)' : '';
        chatOutput.write(
            `Approval level set to: ${selected}${applied}\n  ${APPROVAL_LEVEL_META[selected].description}\n`,
        );
        return actionResult(selection, activeTurn, { approvalLevel: selected });
    }
    if (requestedLevel === undefined && selectApprovalLevel !== undefined) return actionResult(selection, activeTurn);
    const level = currentLevel ?? 'safe';
    chatOutput.write(`Approval level: ${level}\n  ${APPROVAL_LEVEL_META[level].description}\n`);
    return actionResult(selection, activeTurn);
}
