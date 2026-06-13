import type { AgentMessage } from '@mission-control/protocol';
import { ProjectTrustStore } from '../trust/project-trust-store.js';
import { loadProjectResources } from './project-resource-loader.js';

export type ProjectContextMessageOptions = {
    readonly workspaceRoot: string;
    readonly trustStore?: ProjectTrustStore;
    readonly paths?: readonly string[];
    readonly maxBytes?: number;
};

export async function loadProjectContextMessages(
    options: ProjectContextMessageOptions,
): Promise<readonly AgentMessage[]> {
    const loaded = await loadProjectResources({
        workspaceRoot: options.workspaceRoot,
        trustStore: options.trustStore ?? new ProjectTrustStore(),
        ...(options.paths !== undefined ? { paths: options.paths } : {}),
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    });
    if (loaded.status !== 'loaded' || loaded.resources.length === 0) {
        return [];
    }
    return [
        {
            role: 'system',
            content: formatProjectContext(loaded.resources),
        },
    ];
}

export async function prependProjectContextMessages(
    messages: readonly AgentMessage[],
    options: ProjectContextMessageOptions | undefined,
): Promise<readonly AgentMessage[]> {
    if (options === undefined) {
        return messages;
    }
    const contextMessages = await loadProjectContextMessages(options);
    return contextMessages.length === 0 ? messages : [...contextMessages, ...messages];
}

function formatProjectContext(resources: readonly { readonly path: string; readonly content: string }[]): string {
    return [
        'Project-local instructions from a trusted workspace:',
        ...resources.flatMap((resource) => [`--- ${resource.path} ---`, resource.content]),
    ].join('\n');
}
