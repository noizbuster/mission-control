import {
    type AgentEvent,
    type NativeSidecarStatus,
    SIDECAR_PROTOCOL_VERSION,
    type SidecarCapability,
    type SidecarTaskInput,
    type SidecarTaskOutput,
    type SidecarWireResponse,
    SidecarWireResponseSchema,
} from '@mission-control/protocol';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

export interface SidecarClient {
    status(): NativeSidecarStatus;
    capabilities(): readonly SidecarCapability[];
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
    private nativeStatus: NativeSidecarStatus = 'unknown';
    private negotiatedCapabilities: readonly SidecarCapability[] = [];
    private handshakeCompleted = false;

    constructor(
        private readonly command: string,
        private readonly timeoutMs = 5000,
    ) {}

    status(): NativeSidecarStatus {
        return this.nativeStatus;
    }

    capabilities(): readonly SidecarCapability[] {
        return this.negotiatedCapabilities;
    }

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
                this.nativeStatus = 'unavailable';
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
        this.nativeStatus = 'unknown';
        this.negotiatedCapabilities = [];
        this.handshakeCompleted = false;
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
            let handshakeAccepted = this.handshakeCompleted;
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
                    const response = parseSidecarWireResponse(line);
                    if (response.type === 'handshake_completed') {
                        this.nativeStatus = 'native';
                        this.negotiatedCapabilities = response.capabilities;
                        this.handshakeCompleted = true;
                        handshakeAccepted = true;
                        continue;
                    }
                    if (!handshakeAccepted) {
                        settleReject(new SidecarProtocolError('sidecar response arrived before handshake completed'));
                        return;
                    }
                    const event = sidecarResponseToAgentEvent(response);
                    if (event.type === 'task.completed') {
                        settleResolve({
                            id: event.taskId ?? input.id,
                            message: event.message ?? 'completed by rust sidecar',
                            nativeSidecarStatus: 'native',
                        });
                    }
                }
            };
            const onError = (error: Error): void => {
                settleReject(new SidecarProtocolError(`sidecar process error: ${error.message}`));
            };
            const onExit = (code: number | null): void => {
                this.nativeStatus = 'unavailable';
                settleReject(new SidecarProtocolError(`sidecar exited before completing task: ${String(code)}`));
            };

            child.stdout.on('data', onData);
            child.once('error', onError);
            child.once('exit', onExit);
            if (!this.handshakeCompleted) {
                child.stdin.write(
                    `${JSON.stringify({
                        type: 'handshake',
                        id: `handshake_${input.id}`,
                        payload: {
                            protocolVersion: SIDECAR_PROTOCOL_VERSION,
                            clientName: 'mission-control-core',
                        },
                    })}\n`,
                );
            }
            child.stdin.write(`${JSON.stringify({ type: 'run_task', id: input.id, payload: input.payload })}\n`);
        });
    }
}

export function normalizeSidecarLine(line: string, sessionId?: string): AgentEvent {
    return sidecarResponseToAgentEvent(parseSidecarWireResponse(line), sessionId);
}

export function parseSidecarWireResponse(line: string): SidecarWireResponse {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            throw new SidecarProtocolError(`sidecar response is not valid JSON: ${error.message}`);
        }
        throw error;
    }

    const result = SidecarWireResponseSchema.safeParse(parsed);
    if (!result.success) {
        throw new SidecarProtocolError('sidecar response failed protocol validation');
    }
    return result.data;
}

function sidecarResponseToAgentEvent(response: SidecarWireResponse, sessionId?: string): AgentEvent {
    switch (response.type) {
        case 'handshake_completed':
            return {
                type: 'native.status',
                timestamp: new Date().toISOString(),
                ...(sessionId ? { sessionId } : {}),
                taskId: response.id,
                message: `sidecar protocol v${String(response.protocolVersion)} capabilities: ${response.capabilities.join(', ')}`,
                nativeSidecarStatus: 'native',
            };
        case 'task_progress': {
            return {
                type: 'task.progress',
                timestamp: new Date().toISOString(),
                ...(sessionId ? { sessionId } : {}),
                taskId: response.id,
                progress: response.progress,
                nativeSidecarStatus: 'native',
            };
        }
        case 'task_completed': {
            return {
                type: 'task.completed',
                timestamp: new Date().toISOString(),
                ...(sessionId ? { sessionId } : {}),
                taskId: response.id,
                message: response.result.message,
                nativeSidecarStatus: 'native',
            };
        }
        default:
            return assertNever(response);
    }
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected sidecar response: ${JSON.stringify(value)}`);
}
