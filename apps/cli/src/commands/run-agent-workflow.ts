import { discoverWorkflows, PluginManager, registerBuiltinWorkflows, WorkflowRegistry } from '@mission-control/core';
import type { AbgGraphSpec, PolicyEffectRule, WorkflowSpec } from '@mission-control/protocol';
import { splitCommandParts } from './chat-command-parts';
import {
    graphForDefaultFallback,
    graphForWorkflowSpec,
    modePoliciesForDefaultFallback,
    modePoliciesForWorkflowSpec,
} from './workflow-materialization';

const WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.:/-]+$/;

export type WorkflowInvocation = {
    readonly name: string;
    readonly prompt: string;
};

export type WorkflowInvocationInput = {
    readonly workflowName?: string;
    readonly prompt?: string;
};

export type NoninteractiveWorkflowSelection = {
    readonly effectivePrompt?: string;
    readonly workflowGraph?: AbgGraphSpec;
    readonly workflowSpec?: WorkflowSpec;
    /** Active-mode policy rules paired with `workflowGraph` for two-layer mode enforcement. */
    readonly workflowModePolicies?: readonly PolicyEffectRule[];
};
export function resolveWorkflowInvocation(args: WorkflowInvocationInput): WorkflowInvocation | undefined {
    if (args.workflowName !== undefined) {
        return { name: args.workflowName, prompt: args.prompt ?? '' };
    }
    if (args.prompt?.startsWith('#')) {
        const parts = splitCommandParts(args.prompt.slice(1));
        if (parts.head.length === 0) {
            throw new Error('Workflow invocation requires a name after "#"');
        }
        if (!WORKFLOW_NAME_PATTERN.test(parts.head)) {
            throw new Error(`Invalid workflow name: "${parts.head}"`);
        }
        return { name: parts.head, prompt: parts.tail };
    }
    return undefined;
}

export async function discoverWorkflowRegistry(workspaceRoot: string): Promise<WorkflowRegistry> {
    const pluginManager = new PluginManager({ workspaceRoot });
    let pluginWorkflowDirs: readonly string[] = [];
    try {
        await pluginManager.initialize();
        pluginWorkflowDirs = pluginManager.getWorkflowDirs();
        for (const diagnostic of pluginManager.getDiagnostics()) {
            process.stderr.write(
                `plugin discovery [${diagnostic.severity}] ${diagnostic.pluginName}: ${diagnostic.message}\n`,
            );
        }
    } catch (error: unknown) {
        process.stderr.write(
            `plugin discovery [warning] skipped: ${error instanceof Error ? error.message : String(error)}\n`,
        );
    }

    const result = await discoverWorkflows({
        workspaceRoot,
        ...(pluginWorkflowDirs.length > 0 ? { additionalWorkflowDirs: pluginWorkflowDirs } : {}),
    });
    for (const diagnostic of result.diagnostics) {
        process.stderr.write(
            `workflow discovery [${diagnostic.severity}] ${diagnostic.workflowName}: ${diagnostic.message}\n`,
        );
    }
    const registry = new WorkflowRegistry(result.workflows);
    registerBuiltinWorkflows(registry);
    try {
        await pluginManager.registerInto(registry);
    } catch (error: unknown) {
        process.stderr.write(
            `plugin registration [warning] skipped: ${error instanceof Error ? error.message : String(error)}\n`,
        );
    }
    return registry;
}

export async function resolveNoninteractiveWorkflowSelection(input: {
    readonly args: WorkflowInvocationInput;
    readonly workspaceRoot: string;
    readonly graph: AbgGraphSpec | undefined;
}): Promise<NoninteractiveWorkflowSelection> {
    const workflowInvocation = resolveWorkflowInvocation(input.args);
    if (workflowInvocation !== undefined) {
        const registry = await discoverWorkflowRegistry(input.workspaceRoot);
        const spec = registry.lookup(workflowInvocation.name);
        if (spec === undefined) {
            const names = registry.names();
            const available = names.length === 0 ? '(none discovered)' : names.slice(0, 20).join(', ');
            throw new Error(`Unknown workflow "${workflowInvocation.name}". Available workflows: ${available}.`);
        }
        const selectionModePolicies = modePoliciesForWorkflowSpec(spec);
        return {
            effectivePrompt: workflowInvocation.prompt,
            workflowGraph: graphForWorkflowSpec(spec),
            workflowSpec: spec,
            ...(selectionModePolicies !== undefined ? { workflowModePolicies: selectionModePolicies } : {}),
        };
    }
    if (input.graph === undefined && input.args.prompt !== undefined) {
        const registry = await discoverWorkflowRegistry(input.workspaceRoot);
        const fallbackGraph = graphForDefaultFallback(registry);
        if (fallbackGraph === undefined) {
            return { effectivePrompt: input.args.prompt };
        }
        const fallbackModePolicies = modePoliciesForDefaultFallback(registry);
        return {
            effectivePrompt: input.args.prompt,
            workflowGraph: fallbackGraph,
            ...(fallbackModePolicies !== undefined ? { workflowModePolicies: fallbackModePolicies } : {}),
        };
    }
    return input.args.prompt === undefined ? {} : { effectivePrompt: input.args.prompt };
}
