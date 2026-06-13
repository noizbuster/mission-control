import { type JsonlSessionEventStore as SessionStore } from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import {
    formatSessionSummary,
    formatSessionTree,
    latestSelection,
} from './interactive-chat-session-navigation-format.js';
import {
    appendSessionNavigationEvent,
    assertReplayIsReadable,
    copyDurableReplayEnvelopes,
    createSessionNavigationEvent,
    finalizeAndSwitchTargetSession,
    prepareTargetSession,
    readSessionNavigationReplay,
    requireCurrentSessionId,
    requireCurrentStore,
    SessionNavigationError,
    validatedSessionId,
} from './interactive-chat-session-navigation-store.js';
import { formatSessionCatalogEntry, listSessionCatalogEntries } from './session-catalog.js';

export type SessionNavigationResult = {
    readonly message: string;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly sessionId?: string;
    readonly sessionStore?: SessionStore;
};

export type SessionNavigationController = {
    readonly startNewSession: (input: {
        readonly modelProviderSelection: ModelProviderSelection;
        readonly sessionId?: string;
    }) => Promise<SessionNavigationResult>;
    readonly switchSession: (input: { readonly sessionId: string }) => Promise<SessionNavigationResult>;
    readonly listSessions: () => Promise<SessionNavigationResult>;
    readonly showSession: (input: { readonly sessionId?: string }) => Promise<SessionNavigationResult>;
    readonly showTree: (input: { readonly sessionId?: string }) => Promise<SessionNavigationResult>;
    readonly forkSession: (input: {
        readonly entryId: string;
        readonly modelProviderSelection: ModelProviderSelection;
        readonly sessionId?: string;
    }) => Promise<SessionNavigationResult>;
    readonly cloneSession: (input: {
        readonly modelProviderSelection: ModelProviderSelection;
        readonly sessionId?: string;
    }) => Promise<SessionNavigationResult>;
    readonly selectBranch: (input: {
        readonly entryId: string;
        readonly modelProviderSelection: ModelProviderSelection;
    }) => Promise<SessionNavigationResult>;
};

export function createSessionNavigationController(input: {
    readonly getCurrentSessionId: () => string | undefined;
    readonly getCurrentStore: () => SessionStore | undefined;
    readonly switchSessionStore: (sessionId: string) => Promise<SessionStore>;
    readonly observeStoredEvent?: (event: AgentEvent) => void;
    readonly workspaceRoot?: string;
}): SessionNavigationController {
    return {
        startNewSession: async ({ modelProviderSelection, sessionId }) => {
            const prepared = await prepareTargetSession({
                fallbackSelection: modelProviderSelection,
                startedMessage: 'interactive session started',
                observeStoredEvent: input.observeStoredEvent,
                ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
                ...(sessionId !== undefined ? { requestedSessionId: sessionId } : {}),
            });
            const store = await finalizeAndSwitchTargetSession(prepared, input.switchSessionStore);
            return {
                message: `Started new session: ${prepared.sessionId}\n`,
                sessionId: prepared.sessionId,
                sessionStore: store,
            };
        },
        switchSession: async ({ sessionId }) => {
            const replay = await readSessionNavigationReplay(validatedSessionId(sessionId));
            assertReplayIsReadable(replay, sessionId, 'switch');
            const store = await input.switchSessionStore(sessionId);
            const selection = latestSelection(replay);
            return {
                message: `Switched to session: ${sessionId}\n${formatSessionSummary(sessionId, replay)}`,
                ...(selection !== undefined ? { modelProviderSelection: selection } : {}),
                sessionId,
                sessionStore: store,
            };
        },
        listSessions: async () => {
            const currentSessionId = input.getCurrentSessionId();
            const lines = (await listSessionCatalogEntries()).map(
                (entry) => `${entry.sessionId === currentSessionId ? '* ' : '  '}${formatSessionCatalogEntry(entry)}`,
            );
            return { message: `${lines.join('\n')}\n` };
        },
        showSession: async ({ sessionId }) => {
            const resolvedSessionId = validatedSessionId(
                sessionId ?? requireCurrentSessionId(input.getCurrentSessionId()),
            );
            const replay = await readSessionNavigationReplay(resolvedSessionId);
            return { message: formatSessionSummary(resolvedSessionId, replay) };
        },
        showTree: async ({ sessionId }) => {
            const resolvedSessionId = validatedSessionId(
                sessionId ?? requireCurrentSessionId(input.getCurrentSessionId()),
            );
            const replay = await readSessionNavigationReplay(resolvedSessionId);
            return { message: formatSessionTree(resolvedSessionId, replay) };
        },
        forkSession: async ({ entryId, modelProviderSelection, sessionId }) => {
            const sourceSessionId = requireCurrentSessionId(input.getCurrentSessionId());
            const replay = await readSessionNavigationReplay(sourceSessionId);
            assertReplayIsReadable(replay, sourceSessionId, 'fork');
            const sourceNode = replay.projection.sessionTree.nodes.find((node) => node.entryId === entryId);
            if (sourceNode === undefined) {
                throw new SessionNavigationError(`Session tree entry not found: ${entryId}`);
            }
            const prepared = await prepareTargetSession({
                fallbackSelection: modelProviderSelection,
                replay,
                startedMessage: 'forked session started',
                observeStoredEvent: input.observeStoredEvent,
                ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
                ...(sessionId !== undefined ? { requestedSessionId: sessionId } : {}),
            });
            await copyDurableReplayEnvelopes(
                prepared.store,
                prepared.sessionId,
                replay.projection.envelopes.filter((envelope) => envelope.sequence <= sourceNode.sequence),
                input.observeStoredEvent,
            );
            await appendSessionNavigationEvent(
                prepared.store,
                createSessionNavigationEvent(prepared.sessionId, 'session.forked', prepared.selection, {
                    message: `forked from ${sourceSessionId}:${entryId}`,
                    sessionTree: {
                        kind: 'fork',
                        parentSessionId: sourceSessionId,
                        source: { sessionId: sourceSessionId, entryId },
                    },
                }),
                input.observeStoredEvent,
            );
            await appendSessionNavigationEvent(
                prepared.store,
                createSessionNavigationEvent(prepared.sessionId, 'session.tree.active_leaf', prepared.selection, {
                    message: `active branch ${entryId}`,
                    sessionTree: { kind: 'active_leaf', entryId },
                }),
                input.observeStoredEvent,
            );
            const store = await finalizeAndSwitchTargetSession(prepared, input.switchSessionStore);
            return {
                message: `Forked session: ${prepared.sessionId} from ${entryId}\n`,
                sessionId: prepared.sessionId,
                sessionStore: store,
            };
        },
        cloneSession: async ({ modelProviderSelection, sessionId }) => {
            const sourceSessionId = requireCurrentSessionId(input.getCurrentSessionId());
            const replay = await readSessionNavigationReplay(sourceSessionId);
            assertReplayIsReadable(replay, sourceSessionId, 'clone');
            const prepared = await prepareTargetSession({
                fallbackSelection: modelProviderSelection,
                replay,
                startedMessage: 'cloned session started',
                observeStoredEvent: input.observeStoredEvent,
                ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
                ...(sessionId !== undefined ? { requestedSessionId: sessionId } : {}),
            });
            await copyDurableReplayEnvelopes(
                prepared.store,
                prepared.sessionId,
                replay.projection.envelopes,
                input.observeStoredEvent,
            );
            await appendSessionNavigationEvent(
                prepared.store,
                createSessionNavigationEvent(prepared.sessionId, 'session.cloned', prepared.selection, {
                    message: `cloned from ${sourceSessionId}`,
                    sessionTree: {
                        kind: 'clone',
                        parentSessionId: sourceSessionId,
                        source: { sessionId: sourceSessionId, entryId: replay.projection.sessionTree.activeLeafId },
                    },
                }),
                input.observeStoredEvent,
            );
            const store = await finalizeAndSwitchTargetSession(prepared, input.switchSessionStore);
            return {
                message: `Cloned session: ${prepared.sessionId}\n`,
                sessionId: prepared.sessionId,
                sessionStore: store,
            };
        },
        selectBranch: async ({ entryId, modelProviderSelection }) => {
            const sessionId = requireCurrentSessionId(input.getCurrentSessionId());
            const store = requireCurrentStore(input.getCurrentStore());
            const replay = await readSessionNavigationReplay(sessionId);
            assertReplayIsReadable(replay, sessionId, 'select branch');
            if (!replay.projection.sessionTree.nodes.some((node) => node.entryId === entryId)) {
                throw new SessionNavigationError(`Session tree entry not found: ${entryId}`);
            }
            await appendSessionNavigationEvent(
                store,
                createSessionNavigationEvent(sessionId, 'session.tree.active_leaf', modelProviderSelection, {
                    message: `active branch ${entryId}`,
                    sessionTree: { kind: 'active_leaf', entryId },
                }),
                input.observeStoredEvent,
            );
            return { message: `Active branch: ${entryId}\n` };
        },
    };
}
