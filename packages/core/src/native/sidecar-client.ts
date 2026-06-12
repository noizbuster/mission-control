import {
    type NativeSidecarStatus,
    SIDECAR_PROTOCOL_V2_VERSION,
    SIDECAR_PROTOCOL_VERSION,
    type SidecarCapability,
    type SidecarHandshakeResponse,
    type SidecarProtocolVersion,
    type SidecarTaskInput,
    type SidecarTaskOutput,
    type SidecarWireResponse,
} from '@mission-control/protocol';
import { SidecarProtocolError } from './sidecar-errors.js';
import { parseSidecarWireResponse, sidecarResponseToAgentEvent } from './sidecar-wire.js';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

export { SidecarProtocolError } from './sidecar-errors.js';
export { normalizeSidecarLine, parseSidecarWireResponse } from './sidecar-wire.js';

export type ProcessSidecarClientOptions = {
    readonly enableProtocolV2?: boolean;
};

export type NegotiatedSidecarCapability = SidecarCapability | 'task.cancel';

export interface SidecarClient {
    status(): NativeSidecarStatus;
    capabilities(): readonly NegotiatedSidecarCapability[];
    start(): Promise<void>;
    stop(): Promise<void>;
    runTask(input: SidecarTaskInput): Promise<SidecarTaskOutput>;
}

export class ProcessSidecarClient implements SidecarClient {
    private child: ChildProcessWithoutNullStreams | undefined;
    private nativeStatus: NativeSidecarStatus = 'unknown';
    private negotiatedCapabilities: readonly NegotiatedSidecarCapability[] = [];
    private handshakeCompleted = false;

    constructor(
        private readonly command: string,
        private readonly timeoutMs = 5000,
        private readonly options: ProcessSidecarClientOptions = {},
    ) {}

    status(): NativeSidecarStatus {
        return this.nativeStatus;
    }

    capabilities(): readonly NegotiatedSidecarCapability[] {
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
                    let response: SidecarWireResponse;
                    try {
                        response = parseSidecarWireResponse(line);
                    } catch (error: unknown) {
                        settleReject(toSidecarProtocolError(error));
                        return;
                    }
                    if (response.type === 'handshake_completed') {
                        try {
                            this.acceptHandshake(response);
                            handshakeAccepted = true;
                        } catch (error: unknown) {
                            settleReject(toSidecarProtocolError(error));
                            return;
                        }
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
                        return;
                    }
                    if (event.type === 'task.failed') {
                        settleReject(new SidecarProtocolError(event.message ?? 'sidecar task failed'));
                        return;
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
                            protocolVersion: this.requestedProtocolVersion(),
                            clientName: 'mission-control-core',
                            ...this.handshakeCapabilities(),
                        },
                    })}\n`,
                );
            }
            child.stdin.write(`${JSON.stringify({ type: 'run_task', id: input.id, payload: input.payload })}\n`);
        });
    }

    private requestedProtocolVersion(): SidecarProtocolVersion {
        return this.options.enableProtocolV2 === true ? SIDECAR_PROTOCOL_V2_VERSION : SIDECAR_PROTOCOL_VERSION;
    }

    private handshakeCapabilities(): { readonly requestedCapabilities?: readonly NegotiatedSidecarCapability[] } {
        if (this.options.enableProtocolV2 !== true) {
            return {};
        }
        return { requestedCapabilities: ['task.cancel'] };
    }

    private acceptHandshake(response: SidecarHandshakeResponse): void {
        const requestedVersion = this.requestedProtocolVersion();
        if (response.protocolVersion !== requestedVersion) {
            throw new SidecarProtocolError(
                `sidecar protocol version mismatch: requested v${String(requestedVersion)} but received v${String(response.protocolVersion)}`,
            );
        }
        if (requestedVersion === SIDECAR_PROTOCOL_V2_VERSION && !hasCapability(response.capabilities, 'task.cancel')) {
            throw new SidecarProtocolError('sidecar protocol v2 did not negotiate task.cancel');
        }
        this.nativeStatus = 'native';
        this.negotiatedCapabilities = response.capabilities;
        this.handshakeCompleted = true;
    }
}

function hasCapability(capabilities: readonly string[], capability: string): boolean {
    return capabilities.includes(capability);
}

function toSidecarProtocolError(error: unknown): SidecarProtocolError {
    if (error instanceof SidecarProtocolError) {
        return error;
    }
    if (error instanceof Error) {
        return new SidecarProtocolError(error.message);
    }
    return new SidecarProtocolError(String(error));
}
