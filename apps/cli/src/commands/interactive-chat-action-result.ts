import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ApprovalLevel } from '@mission-control/tui/state';
import type { PromptTurnContext } from './interactive-chat-prompt-turn';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent';

export type ChatActionResult = {
    readonly modelProviderSelection: ModelProviderSelection;
    readonly activeTurn?: ActiveCodingAgentTurn;
    readonly persistModelProviderSelection?: boolean;
    readonly sessionId?: string;
    readonly sessionStore?: PromptTurnContext['sessionStore'];
    readonly approvalLevel?: ApprovalLevel;
};

export function actionResult(
    modelProviderSelection: ModelProviderSelection,
    activeTurn?: ActiveCodingAgentTurn,
    extras?: {
        readonly persistModelProviderSelection?: boolean;
        readonly sessionId?: string;
        readonly sessionStore?: PromptTurnContext['sessionStore'];
        readonly approvalLevel?: ApprovalLevel;
    },
): ChatActionResult {
    return {
        modelProviderSelection,
        ...(activeTurn !== undefined ? { activeTurn } : {}),
        ...(extras?.persistModelProviderSelection === true ? { persistModelProviderSelection: true } : {}),
        ...(extras?.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
        ...(extras?.sessionStore !== undefined ? { sessionStore: extras.sessionStore } : {}),
        ...(extras?.approvalLevel !== undefined ? { approvalLevel: extras.approvalLevel } : {}),
    };
}
