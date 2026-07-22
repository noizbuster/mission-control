import type { AgentRuntime } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { SessionFinalizeInfo } from './session-finalize';

export interface AgentUIRenderer {
    start(runtime: AgentRuntime): Promise<void>;
    render(event: AgentEvent): void;
    stop(): Promise<void>;
    getOutput(): string;
    /** When true, render() already wrote output to stdout; callers must NOT write getOutput() again. */
    readonly streamedOutput?: boolean;
    /**
     * Emit the terminal session-finalize line. Called exactly once after
     * `stop()` resolves. Renderers that stream to stdout write the line live
     * AND include it in `getOutput()` so test harnesses observe it. JSON
     * renderers append a synthetic `session.finalize` event line.
     *
     * Implementations MUST be idempotent: a second call is a no-op.
     */
    finalize?(info: SessionFinalizeInfo): void;
}
