import type { AgentMessage } from '@mission-control/protocol';
import { prependProjectContextMessages } from '../context/project-context-messages';
import { projectApprovalContinuationMessages } from '../session-continuation-projection';
import type { SessionRunCoordinatorOptions } from './run-coordinator-types';

export async function readRunCoordinatorMessages(
    options: Pick<SessionRunCoordinatorOptions, 'projectContext' | 'readMessages' | 'sessionId' | 'store'>,
): Promise<readonly AgentMessage[]> {
    if (options.readMessages !== undefined) {
        return prependProjectContextMessages(await options.readMessages(), options.projectContext);
    }
    const events = await options.store.getEvents(options.sessionId);
    return prependProjectContextMessages(
        projectApprovalContinuationMessages(events, options.sessionId),
        options.projectContext,
    );
}
