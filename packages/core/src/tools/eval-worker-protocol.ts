/**
 * Eval Worker IPC protocol.
 *
 * Defines the message shapes exchanged between the eval context manager (host)
 * and the isolated `worker_threads` worker that owns a persistent `vm` context.
 * Ported from oh-my-pi's `worker-protocol.ts`, simplified to the surface the
 * sandbox MVP needs. Tool re-entry (`tool-call` / `tool-reply`) is declared here
 * so the worker boundary is stable, but the simplified manager does not drive it.
 */

export type EvalWorkerInbound =
    | { readonly type: 'init'; readonly sessionId: string }
    | {
          readonly type: 'run';
          readonly runId: string;
          readonly code: string;
          readonly timeoutMs: number;
      }
    | {
          readonly type: 'tool-reply';
          readonly id: string;
          readonly reply:
              | { readonly ok: true; readonly value: unknown }
              | { readonly ok: false; readonly error: string };
      }
    | { readonly type: 'close' };

export type EvalWorkerOutbound =
    | { readonly type: 'ready' }
    | { readonly type: 'text'; readonly runId: string; readonly chunk: string }
    | {
          readonly type: 'result';
          readonly runId: string;
          readonly ok: boolean;
          readonly output: string;
          readonly error?: string;
      }
    | {
          readonly type: 'tool-call';
          readonly id: string;
          readonly runId: string;
          readonly name: string;
          readonly args: unknown;
      };

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Parse a raw `worker_threads` message into a typed outbound message.
 * Returns `undefined` for malformed payloads so the host can drop them silently
 * rather than crashing the run on a bad chunk.
 */
export function parseEvalWorkerOutbound(message: unknown): EvalWorkerOutbound | undefined {
    if (!isRecord(message)) {
        return undefined;
    }
    const type = message['type'];
    if (typeof type !== 'string') {
        return undefined;
    }
    switch (type) {
        case 'ready':
            return { type: 'ready' };
        case 'text': {
            const runId = message['runId'];
            const chunk = message['chunk'];
            if (typeof runId !== 'string' || typeof chunk !== 'string') {
                return undefined;
            }
            return { type: 'text', runId, chunk };
        }
        case 'result': {
            const runId = message['runId'];
            const ok = message['ok'];
            const output = message['output'];
            const error = message['error'];
            if (
                typeof runId !== 'string' ||
                typeof ok !== 'boolean' ||
                typeof output !== 'string' ||
                (error !== undefined && typeof error !== 'string')
            ) {
                return undefined;
            }
            return error === undefined
                ? { type: 'result', runId, ok, output }
                : { type: 'result', runId, ok, output, error };
        }
        case 'tool-call': {
            const id = message['id'];
            const runId = message['runId'];
            const name = message['name'];
            const args = message['args'];
            if (typeof id !== 'string' || typeof runId !== 'string' || typeof name !== 'string') {
                return undefined;
            }
            return { type: 'tool-call', id, runId, name, args };
        }
        default:
            return undefined;
    }
}
