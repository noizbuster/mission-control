import type { ModelProviderSelection } from '@mission-control/protocol';
import type { PromptTurnContext } from './interactive-chat-prompt-turn.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';

export type ChatActionResult = {
    readonly modelProviderSelection: ModelProviderSelection;
    readonly activeTurn?: ActiveCodingAgentTurn;
    readonly persistModelProviderSelection?: boolean;
    readonly sessionId?: string;
    readonly sessionStore?: PromptTurnContext['sessionStore'];
};

export function actionResult(
    modelProviderSelection: ModelProviderSelection,
    activeTurn?: ActiveCodingAgentTurn,
    extras?: {
        readonly persistModelProviderSelection?: boolean;
        readonly sessionId?: string;
        readonly sessionStore?: PromptTurnContext['sessionStore'];
    },
): ChatActionResult {
    return {
        modelProviderSelection,
        ...(activeTurn !== undefined ? { activeTurn } : {}),
        ...(extras?.persistModelProviderSelection === true ? { persistModelProviderSelection: true } : {}),
        ...(extras?.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
        ...(extras?.sessionStore !== undefined ? { sessionStore: extras.sessionStore } : {}),
    };
}
