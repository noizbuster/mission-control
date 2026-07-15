import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
    type McpRemoteClientHandle,
    type RemoteClientFactory,
    RemoteMcpClient,
    type RemoteTransportFactory,
} from './http-client';

type TransportBehavior = {
    readonly startError?: Error;
};

type ClientBehavior = {
    readonly listToolsResult?: unknown;
    readonly callToolResult?: unknown;
    readonly listToolsHangs?: boolean;
    readonly callToolError?: Error;
    readonly connectError?: Error;
};

type FactoryCall = { readonly url: URL; readonly requestInit: RequestInit | undefined };

type Captures = {
    readonly streamableCalls: FactoryCall[];
    readonly sseCalls: FactoryCall[];
    readonly transports: FakeTransport[];
    readonly clients: FakeClientHandle[];
};

export function buildRemoteMcpTestClient(options: {
    readonly url?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly secrets?: readonly string[];
    readonly idleTimeoutMs?: number;
    readonly streamableBehavior?: TransportBehavior;
    readonly sseBehavior?: TransportBehavior;
    readonly clientBehavior?: ClientBehavior;
}): { readonly client: RemoteMcpClient; readonly captures: Captures } {
    const captures: Captures = { streamableCalls: [], sseCalls: [], transports: [], clients: [] };
    const streamableBehavior = options.streamableBehavior ?? {};
    const sseBehavior = options.sseBehavior ?? {};
    const clientBehavior = options.clientBehavior ?? {};

    const streamableFactory: RemoteTransportFactory = (url, factoryOptions) => {
        captures.streamableCalls.push({ url, requestInit: factoryOptions?.requestInit });
        const transport = new FakeTransport(streamableBehavior);
        captures.transports.push(transport);
        return transport;
    };
    const sseFactory: RemoteTransportFactory = (url, factoryOptions) => {
        captures.sseCalls.push({ url, requestInit: factoryOptions?.requestInit });
        const transport = new FakeTransport(sseBehavior);
        captures.transports.push(transport);
        return transport;
    };
    const clientFactory: RemoteClientFactory = () => {
        const handle = new FakeClientHandle(clientBehavior);
        captures.clients.push(handle);
        return handle;
    };

    const client = new RemoteMcpClient({
        url: options.url ?? 'https://mcp.example.test/endpoint',
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
        ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
        streamableTransportFactory: streamableFactory,
        sseTransportFactory: sseFactory,
        clientFactory,
    });
    return { client, captures };
}

class FakeTransport {
    readonly received: unknown[] = [];
    readonly closeCalls = numberRef();
    private readonly behavior: TransportBehavior;

    constructor(behavior: TransportBehavior) {
        this.behavior = behavior;
    }

    async start(): Promise<void> {
        if (this.behavior.startError !== undefined) {
            throw this.behavior.startError;
        }
    }

    async send(message: unknown): Promise<void> {
        this.received.push(message);
    }

    async close(): Promise<void> {
        this.closeCalls.value += 1;
    }
}

export class FakeAuthError extends Error {
    readonly code: number;

    constructor(code: number, message: string) {
        super(message);
        this.name = 'FakeAuthError';
        this.code = code;
    }
}

class FakeClientHandle implements McpRemoteClientHandle {
    readonly listToolsCalls = numberRef();
    readonly callToolCalls = numberRef();
    readonly closeCalls = numberRef();
    readonly connectCalls = numberRef();
    private readonly behavior: ClientBehavior;

    constructor(behavior: ClientBehavior) {
        this.behavior = behavior;
    }

    async connect(transport: Transport, _options?: RequestOptions): Promise<void> {
        this.connectCalls.value += 1;
        if (this.behavior.connectError !== undefined) {
            throw this.behavior.connectError;
        }
        await transport.start();
    }

    async listTools(_params?: object, _options?: RequestOptions): Promise<unknown> {
        this.listToolsCalls.value += 1;
        if (this.behavior.listToolsHangs === true) {
            return new Promise<never>(() => {});
        }
        return this.behavior.listToolsResult ?? { tools: [] };
    }

    async callTool(params: object, _resultSchema?: undefined, _options?: RequestOptions): Promise<unknown> {
        this.callToolCalls.value += 1;
        if (this.behavior.callToolError !== undefined) {
            throw this.behavior.callToolError;
        }
        return this.behavior.callToolResult ?? { echoed: params };
    }

    async close(): Promise<void> {
        this.closeCalls.value += 1;
    }
}

function numberRef(): { value: number } {
    return { value: 0 };
}
