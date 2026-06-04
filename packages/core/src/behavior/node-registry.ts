import type { AbgNodeModelOptions, AbgNodeSpec, AbgPolicySpec, AbgSignal } from '@mission-control/protocol';
import { createCompositeNodeRunners } from './nodes/composite-nodes.js';
import { createLeafNodeRunners } from './nodes/leaf-nodes.js';

export type AbgObservedGraphEvent = {
    readonly type: string;
};

export type AbgNodeRunContext = {
    readonly graphId: string;
    readonly now: () => string;
    readonly registry?: AbgNodeRegistry;
    readonly nodes?: Readonly<Record<string, AbgNodeSpec | undefined>>;
    readonly observedEvents?: readonly AbgObservedGraphEvent[];
    readonly model?: AbgNodeModelOptions;
    readonly policies?: readonly AbgPolicySpec[];
    readonly input?: Readonly<Record<string, unknown>>;
};

export type AbgNodeRunner = (node: AbgNodeSpec, context: AbgNodeRunContext) => AsyncIterable<AbgSignal>;

export class AbgNodeRegistryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AbgNodeRegistryError';
    }
}

export interface AbgNodeRegistry {
    register(id: string, runner: AbgNodeRunner): void;
    resolve(id: string): AbgNodeRunner;
}

export function createAbgNodeRegistry(): AbgNodeRegistry {
    return new DefaultAbgNodeRegistry();
}

export function createDefaultAbgNodeRegistry(): AbgNodeRegistry {
    const registry = createAbgNodeRegistry();
    for (const [id, runner] of createLeafNodeRunners()) {
        registry.register(id, runner);
    }
    for (const [id, runner] of createCompositeNodeRunners()) {
        registry.register(id, runner);
    }
    return registry;
}

export function runAbgNode(
    registry: AbgNodeRegistry,
    node: AbgNodeSpec,
    context: AbgNodeRunContext,
): AsyncIterable<AbgSignal> {
    const implementationId = node.implementation ?? node.kind;
    return registry.resolve(implementationId)(node, context);
}

class DefaultAbgNodeRegistry implements AbgNodeRegistry {
    private readonly runners = new Map<string, AbgNodeRunner>();

    register(id: string, runner: AbgNodeRunner): void {
        if (this.runners.has(id)) {
            throw new AbgNodeRegistryError(`ABG node implementation already registered: ${id}`);
        }
        this.runners.set(id, runner);
    }

    resolve(id: string): AbgNodeRunner {
        const runner = this.runners.get(id);
        if (runner === undefined) {
            throw new AbgNodeRegistryError(`Unknown ABG node implementation: ${id}`);
        }
        return runner;
    }
}
