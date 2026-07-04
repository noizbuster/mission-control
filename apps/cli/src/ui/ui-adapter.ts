import type { AgentRuntime } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';

export interface AgentUIRenderer {
    start(runtime: AgentRuntime): Promise<void>;
    render(event: AgentEvent): void;
    stop(): Promise<void>;
    getOutput(): string;
    /** When true, render() already wrote output to stdout; callers must NOT write getOutput() again. */
    readonly streamedOutput?: boolean;
}
