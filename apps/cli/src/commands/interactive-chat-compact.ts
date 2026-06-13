import {
    type JsonlSessionEventStore,
    type ProviderAdapter,
    ProviderTurnError,
    ProviderTurnRunner,
    prepareSessionCompaction,
    projectJsonlSessionReplayPrefix,
} from '@mission-control/core';
import type { AgentEvent, AgentMessage, ModelProviderSelection } from '@mission-control/protocol';
import type { ChatOutput } from './interactive-chat-io.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';
import { readFile } from 'node:fs/promises';

type CompactionTurnOptions = {
    readonly sessionId: string;
    readonly store: JsonlSessionEventStore;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly output: ChatOutput;
    readonly workspaceRoot?: string;
    readonly observeStoredEvent?: (event: AgentEvent) => void;
};

export function startCompactionTurn(options: CompactionTurnOptions): ActiveCodingAgentTurn {
    const abortController = new AbortController();
    const done = runCompactionTurn(options, abortController.signal).catch((error: unknown) => {
        if (isProviderAborted(error)) {
            options.output.write('Compaction cancelled\n');
            return;
        }
        options.output.write(`Compaction failed: ${errorMessage(error)}\n`);
    });

    return {
        done,
        interrupt: () => {
            abortController.abort();
        },
        answerApproval: () => false,
        hasPendingApproval: () => false,
    };
}

async function runCompactionTurn(options: CompactionTurnOptions, signal: AbortSignal): Promise<void> {
    const preparation = prepareSessionCompaction({
        sessionId: options.sessionId,
        replay: projectJsonlSessionReplayPrefix({
            sessionId: options.sessionId,
            contents: await readFile(options.store.filePath, 'utf8'),
        }),
    });
    if (preparation.status === 'denied') {
        options.output.write(`${preparation.message}\n`);
        return;
    }

    const summary = await generateCompactionSummary(options, preparation.summaryMessages, signal);
    const storedEvent = await options.store.compact({
        sessionId: options.sessionId,
        timestamp: new Date().toISOString(),
        message: `Compacted session history; kept recent context from sequence ${preparation.firstKeptSequence}`,
        summary,
        boundaryEntryId: preparation.boundaryEntryId,
        firstKeptEntryId: preparation.firstKeptEntryId,
        boundarySequence: preparation.boundarySequence,
        firstKeptSequence: preparation.firstKeptSequence,
        modelProviderSelection: options.modelProviderSelection,
        nativeSidecarStatus: 'mock',
    });
    options.observeStoredEvent?.(storedEvent);
    options.output.write(
        `Compacted session ${options.sessionId}; kept recent context from sequence ${preparation.firstKeptSequence}\n`,
    );
}

async function generateCompactionSummary(
    options: CompactionTurnOptions,
    visibleMessages: readonly AgentMessage[],
    signal: AbortSignal,
): Promise<string> {
    const runner = new ProviderTurnRunner({ provider: options.provider, retryLimit: 0 });
    const requestMessages = buildCompactionRequestMessages(visibleMessages);
    const result = await runner.runTurn({
        sessionId: options.sessionId,
        turnId: `compact_${options.sessionId}`,
        requestId: `compact_request_${options.sessionId}`,
        providerID: options.modelProviderSelection.providerID,
        modelID: options.modelProviderSelection.modelID,
        ...(options.modelProviderSelection.variantID !== undefined
            ? { variantID: options.modelProviderSelection.variantID }
            : {}),
        messages: requestMessages,
        startSequence: 0,
        signal,
    });
    if (result.status === 'failed') {
        throw new ProviderTurnError(result.error);
    }
    return result.message.content.trim();
}

function buildCompactionRequestMessages(visibleMessages: readonly AgentMessage[]): readonly AgentMessage[] {
    const safeHistory: AgentMessage[] = [];
    for (const message of visibleMessages) {
        if (message.role === 'tool' || message.role === 'system') {
            continue;
        }
        if (message.role === 'assistant') {
            safeHistory.push({ role: 'assistant', content: message.content });
            continue;
        }
        if (message.role === 'user') {
            safeHistory.push(message);
        }
    }
    return [
        {
            role: 'system',
            content:
                'Summarize the current session for future continuation. Preserve goals, decisions, changed files, tests, and pending work. Omit credentials, tokens, secrets, auth-file contents, and shell environment values.',
        },
        ...safeHistory,
        {
            role: 'user',
            content: 'Write a concise continuation summary for this session.',
        },
    ];
}

function isProviderAborted(error: unknown): boolean {
    return error instanceof ProviderTurnError && error.error.code === 'provider_aborted';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
