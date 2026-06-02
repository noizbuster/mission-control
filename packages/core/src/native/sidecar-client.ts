import type { AgentEvent, SidecarTaskInput, SidecarTaskOutput } from '@mission-control/protocol';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

export interface SidecarClient {
    start(): Promise<void>;
    stop(): Promise<void>;
    runTask(input: SidecarTaskInput): Promise<SidecarTaskOutput>;
}

export class SidecarProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SidecarProtocolError';
    }
}

export class ProcessSidecarClient implements SidecarClient {
    private child: ChildProcessWithoutNullStreams | undefined;

    constructor(
        private readonly command: string,
        private readonly timeoutMs = 5000,
    ) {}

    async start(): Promise<void> {
        if (this.child !== undefined) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const child = spawn(this.command, [], { detached: true, stdio: 'pipe' });
            const cleanup = (): void => {
                child.off('spawn', onSpawn);
                child.off('error', onError);
            };
            const onSpawn = (): void => {
                cleanup();
                this.child = child;
                resolve();
            };
            const onError = (error: Error): void => {
                cleanup();
                reject(new SidecarProtocolError(`failed to start sidecar: ${error.message}`));
            };

            child.once('spawn', onSpawn);
            child.once('error', onError);
        });
    }

    async stop(): Promise<void> {
        const child = this.child;
        if (child === undefined) {
            return;
        }
        this.child = undefined;
        if (child.pid === undefined) {
            child.kill();
            return;
        }
        try {
            process.kill(-child.pid, 'SIGTERM');
        } catch {
            child.kill();
        }
    }

    async runTask(input: SidecarTaskInput): Promise<SidecarTaskOutput> {
        await this.start();
        const child = this.child;
        if (child === undefined) {
            throw new SidecarProtocolError('sidecar process was not started');
        }

        return new Promise<SidecarTaskOutput>((resolve, reject) => {
            let buffer = '';
            let settled = false;
            const timeoutId = setTimeout(() => {
                void this.stop();
                settleReject(new SidecarProtocolError('sidecar task timed out'));
            }, this.timeoutMs);

            const cleanup = (): void => {
                clearTimeout(timeoutId);
                child.stdout.off('data', onData);
                child.off('error', onError);
                child.off('exit', onExit);
            };
            const settleResolve = (output: SidecarTaskOutput): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(output);
            };
            const settleReject = (error: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(error);
            };
            const onData = (chunk: Buffer): void => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.trim().length === 0) {
                        continue;
                    }
                    const event = normalizeSidecarLine(line);
                    if (event.type === 'task.completed') {
                        settleResolve({
                            id: event.taskId ?? input.id,
                            message: event.message ?? 'completed by rust sidecar',
                        });
                    }
                }
            };
            const onError = (error: Error): void => {
                settleReject(new SidecarProtocolError(`sidecar process error: ${error.message}`));
            };
            const onExit = (code: number | null): void => {
                settleReject(new SidecarProtocolError(`sidecar exited before completing task: ${String(code)}`));
            };

            child.stdout.on('data', onData);
            child.once('error', onError);
            child.once('exit', onExit);
            child.stdin.write(`${JSON.stringify({ type: 'run_task', id: input.id, payload: input.payload })}\n`);
        });
    }
}

export function normalizeSidecarLine(line: string, sessionId?: string): AgentEvent {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
        throw new SidecarProtocolError('sidecar response must be an object');
    }

    const type = parsed['type'];
    const id = parsed['id'];
    if (typeof type !== 'string' || typeof id !== 'string') {
        throw new SidecarProtocolError('sidecar response requires string type and id');
    }

    switch (type) {
        case 'task_progress': {
            const progress = parsed['progress'];
            if (typeof progress !== 'number') {
                throw new SidecarProtocolError('task_progress requires numeric progress');
            }
            return {
                type: 'task.progress',
                timestamp: new Date().toISOString(),
                ...(sessionId ? { sessionId } : {}),
                taskId: id,
                progress,
                nativeSidecarStatus: 'native',
            };
        }
        case 'task_completed': {
            const result = parsed['result'];
            if (!isRecord(result) || typeof result['message'] !== 'string') {
                throw new SidecarProtocolError('task_completed requires result.message');
            }
            return {
                type: 'task.completed',
                timestamp: new Date().toISOString(),
                ...(sessionId ? { sessionId } : {}),
                taskId: id,
                message: result['message'],
                nativeSidecarStatus: 'native',
            };
        }
        default:
            throw new SidecarProtocolError(`unsupported sidecar response type: ${type}`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
