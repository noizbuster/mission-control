import type { AgentMessage } from '@mission-control/protocol';
import { prependProjectContextMessages } from '../context/project-context-messages';
import { projectSessionAdmission } from '../session-admission';
import { projectApprovalContinuationMessages } from '../session-continuation-projection';
import type { SessionRunCoordinatorOptions } from './run-coordinator-types';

export async function readRunCoordinatorMessages(
    options: Pick<SessionRunCoordinatorOptions, 'projectContext' | 'readMessages' | 'sessionId' | 'store'>,
): Promise<readonly AgentMessage[]> {
    if (options.readMessages !== undefined) {
        return prependProjectContextMessages(await options.readMessages(), options.projectContext);
    }
    const events = await options.store.getEvents(options.sessionId);
    if (hasCompactionBoundary(events, options.sessionId)) {
        return prependProjectContextMessages(
            projectApprovalContinuationMessages(events, options.sessionId),
            options.projectContext,
        );
    }
    return prependProjectContextMessages(
        projectSessionAdmission(events, options.sessionId).modelVisibleMessages.map(
            (message): AgentMessage => ({ role: message.role, content: message.content }),
        ),
        options.projectContext,
    );
}

function hasCompactionBoundary(
    events: Parameters<typeof projectApprovalContinuationMessages>[0],
    sessionId: string,
): boolean {
    return events.some(
        (event) =>
            event.sessionId === sessionId &&
            event.sessionTree?.kind === 'compaction' &&
            typeof event.sessionTree.summary === 'string' &&
            typeof event.sessionTree.boundarySequence === 'number' &&
            typeof event.sessionTree.firstKeptSequence === 'number',
    );
}
