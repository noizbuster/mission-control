import type { Client } from '@libsql/client';

export interface TaskToolSubagentMirror {
    readonly startSubagentWait: (input: {
        readonly parentSessionId: string;
        readonly childSessionId: string;
        readonly agentId?: string;
        readonly mode: 'sync' | 'detached';
    }) => Promise<void>;
    readonly resolveSubagentWait: (
        input: {
            readonly parentSessionId: string;
            readonly childSessionId: string;
            readonly status: 'completed' | 'failed' | 'cancelled';
            readonly output: string;
        },
        client?: Client,
    ) => Promise<void>;
    readonly startUserInputWait?: (input: {
        readonly sessionId: string;
        readonly toolCallId: string;
    }) => Promise<void>;
    readonly resolveUserInputWait?: (input: {
        readonly sessionId: string;
        readonly toolCallId: string;
    }) => Promise<void>;
}
