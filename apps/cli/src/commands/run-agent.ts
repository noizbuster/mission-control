import { AgentRuntime } from '@mission-control/core';
import type { CliArgs } from '../args.js';
import { type AgentUIRenderer, InkRenderer, JsonRenderer, PlainRenderer } from '../ui/renderers.js';

export async function runAgent(args: CliArgs): Promise<string> {
    const runtime = new AgentRuntime(args.useNative === undefined ? {} : { useNative: args.useNative });
    const renderer = createRenderer(args.mode);
    await renderer.start(runtime);
    const unsubscribe = runtime.onEvent((event) => {
        renderer.render(event);
    });
    await runtime.start();
    await runtime.runDemoTask();
    unsubscribe();
    await renderer.stop();
    return renderer.getOutput();
}

function createRenderer(mode: CliArgs['mode']): AgentUIRenderer {
    switch (mode) {
        case 'plain':
            return new PlainRenderer();
        case 'json':
            return new JsonRenderer();
        case 'ink':
            return new InkRenderer();
        default:
            return assertNever(mode);
    }
}

function assertNever(value: never): never {
    throw new Error(`Unexpected CLI mode: ${String(value)}`);
}
