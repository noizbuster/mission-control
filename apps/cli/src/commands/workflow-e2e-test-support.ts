import type { ProviderAdapter } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { CliArgs } from '../args';
import { createProviderAuthStore } from '../auth-store';
import { createCliProviderForSelection } from './run-agent';

const LOCAL_SELECTION: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };

export const PRODUCTION_DEFAULT_WORKFLOW_FIXTURE = `${process.cwd()}/examples/abg/default.workflow.json`;

export type GraphEvent = {
    readonly type: string;
    readonly abg?: {
        readonly graphId?: string;
        readonly nodeId?: string;
        readonly nodeKind?: string;
        readonly error?: { readonly code?: string };
        readonly emit?: {
            readonly type: string;
            readonly payload?: { readonly key?: unknown; readonly value?: unknown };
        };
    };
};

export function parseWorkflowJsonEvents(output: string): readonly GraphEvent[] {
    return output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as GraphEvent);
}

export function createWorkflowLocalProvider(): ProviderAdapter {
    return createCliProviderForSelection(LOCAL_SELECTION, createProviderAuthStore());
}

export function buildWorkflowArgs(prompt: string, mode: CliArgs['mode']): CliArgs {
    return {
        mode,
        useNative: false,
        command: 'run',
        showHelp: false,
        showVersion: false,
        thinking: false,
        prompt,
        modelProviderSelection: LOCAL_SELECTION,
    };
}
