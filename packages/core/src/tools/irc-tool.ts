/**
 * `irc` tool — short prose between live in-process agents.
 *
 * Process-global message bus routing between concurrent task() children registered in the
 * RuntimeAgentRegistry. A `send` resolves a pending `wait` from the recipient directly or
 * enqueues into the recipient's mailbox (drained via `inbox`/`wait`); `list` shows peer
 * agents. No live session injection: mission-control's registry tracks state only (it holds
 * no live session object), so delivery is mailbox/waiter based rather than the
 * inject-into-turn model the upstream uses. Receipts report `delivered` (waiter resolved or
 * mailbox enqueued) or `failed` (unknown / aborted / advisor recipient).
 *
 * Config-gated: {@linkcode createIrcToolRegistration} returns null when disabled or when the
 * caller has no agent id, so the tool is simply not registered in that case. Capability class
 * `'subagent'` groups it with the task/job tools.
 *
 * Adapted from oh-my-pi's irc tool + IrcBus (MIT, Copyright (c) 2025-2026 Can Bohl),
 * rewritten to mission-control's Zod + ToolRegistration surface and the RuntimeAgentRegistry:
 * no source expression copied, the mailbox/waiter routing pattern reimplemented fresh against
 * this repo's registry (which has no live-session seam).
 */

import { z } from 'zod';
import type { AgentKind, AgentStatus, RuntimeAgentRegistry } from '../agents/runtime-registry.js';
import { getRuntimeRegistry } from '../agents/runtime-registry.js';
import type { ToolRegistration } from './tool-registry-types.js';
import { randomUUID } from 'node:crypto';

export const IRC_TOOL_NAME = 'irc';
const IRC_OUTPUT_LIMIT = { maxModelOutputChars: 6000 } as const;
const DEFAULT_IRC_TIMEOUT_MS = 120_000;
const MIN_IRC_TIMEOUT_MS = 1;
/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

export interface IrcMessage {
    readonly id: string;
    /** Sender agent id. */
    readonly from: string;
    /** Recipient agent id ("all" is expanded by the tool, never stored). */
    readonly to: string;
    readonly body: string;
    readonly ts: number;
    /** Message id being answered, when provided. */
    readonly replyTo?: string;
}

export type IrcDeliveryOutcome = 'delivered' | 'failed';

export interface IrcDeliveryReceipt {
    readonly to: string;
    readonly outcome: IrcDeliveryOutcome;
    readonly error?: string;
}

export interface IrcPeerInfo {
    readonly id: string;
    readonly displayName: string;
    readonly kind: AgentKind;
    readonly status: AgentStatus;
    readonly parentId?: string;
    readonly unread: number;
}

interface IrcWaiter {
    readonly from?: string;
    readonly resolve: (message: IrcMessage) => void;
    readonly reject: (error: Error) => void;
}

/**
 * Process-global mailbox bus for agent-to-agent messaging. Routes messages between live
 * agents tracked by the {@linkcode RuntimeAgentRegistry}. A `send` either resolves a pending
 * `wait` from the recipient or buffers the message in the recipient's mailbox; it never
 * blocks on the recipient generating a reply.
 */
export class IrcBus {
    private readonly mailboxes = new Map<string, IrcMessage[]>();
    private readonly waiters = new Map<string, IrcWaiter[]>();

    constructor(private readonly registry: RuntimeAgentRegistry) {}

    /**
     * Fire-and-forget delivery. Validates the recipient via the registry (must exist, not
     * aborted, not an advisor), then resolves a pending waiter or enqueues into the mailbox.
     */
    async send(message: Omit<IrcMessage, 'id' | 'ts'>): Promise<IrcDeliveryReceipt> {
        const stamped: IrcMessage = { ...message, id: randomUUID(), ts: Date.now() };
        const ref = this.registry.lookup(stamped.to);
        if (ref === undefined || ref.status === 'aborted') {
            return { to: stamped.to, outcome: 'failed', error: `Unknown or terminated agent "${stamped.to}".` };
        }
        if (ref.kind === 'advisor') {
            return {
                to: stamped.to,
                outcome: 'failed',
                error: `Agent "${stamped.to}" is a read-only advisor and cannot be messaged.`,
            };
        }
        const waiter = this.takeMatchingWaiter(stamped.to, stamped.from);
        if (waiter !== undefined) {
            waiter.resolve(stamped);
            return { to: stamped.to, outcome: 'delivered' };
        }
        this.enqueue(stamped);
        return { to: stamped.to, outcome: 'delivered' };
    }

    /**
     * Block until a message for `agentId` (optionally from a specific peer) arrives, then
     * consume and return it. Returns null on timeout (`timeoutMs <= 0` waits indefinitely,
     * still abortable via `signal`). Already-buffered mail satisfies the wait first.
     */
    wait(
        agentId: string,
        filter: { from?: string },
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<IrcMessage | null> {
        if (signal?.aborted) {
            return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('IRC wait aborted'));
        }
        const pending = this.takeFromMailbox(agentId, filter.from);
        if (pending !== undefined) {
            return Promise.resolve(pending);
        }
        return this.parkWaiter(agentId, filter, timeoutMs, signal);
    }

    /** Drain (or peek) pending messages for `agentId`. */
    inbox(agentId: string, options?: { peek?: boolean }): IrcMessage[] {
        const mailbox = this.mailboxes.get(agentId);
        if (mailbox === undefined || mailbox.length === 0) return [];
        if (options?.peek) return [...mailbox];
        this.mailboxes.delete(agentId);
        return mailbox;
    }

    unreadCount(agentId: string): number {
        return this.mailboxes.get(agentId)?.length ?? 0;
    }

    /** Remove every mailbox and waiter. Test-only. */
    clear(): void {
        this.mailboxes.clear();
        const allWaiters = [...this.waiters.values()].flat();
        this.waiters.clear();
        for (const waiter of allWaiters) {
            waiter.reject(new Error('IRC bus cleared'));
        }
    }

    private enqueue(message: IrcMessage): void {
        let mailbox = this.mailboxes.get(message.to);
        if (mailbox === undefined) {
            mailbox = [];
            this.mailboxes.set(message.to, mailbox);
        }
        mailbox.push(message);
        if (mailbox.length > MAILBOX_CAP) {
            mailbox.shift();
        }
    }

    /** Resolve the oldest waiter for `agentId` whose from-filter accepts `from`. */
    private takeMatchingWaiter(agentId: string, from: string): IrcWaiter | undefined {
        const waiters = this.waiters.get(agentId);
        if (waiters === undefined) return undefined;
        const index = waiters.findIndex((waiter) => waiter.from === undefined || waiter.from === from);
        if (index === -1) return undefined;
        const [waiter] = waiters.splice(index, 1);
        if (waiters.length === 0) this.waiters.delete(agentId);
        return waiter;
    }

    private takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
        const mailbox = this.mailboxes.get(agentId);
        if (mailbox === undefined) return undefined;
        const index = from === undefined ? 0 : mailbox.findIndex((message) => message.from === from);
        if (index === -1) return undefined;
        const [message] = mailbox.splice(index, 1);
        if (mailbox.length === 0) this.mailboxes.delete(agentId);
        return message;
    }

    private parkWaiter(
        agentId: string,
        filter: { from?: string },
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<IrcMessage | null> {
        return new Promise<IrcMessage | null>((resolve, reject) => {
            const waiter: IrcWaiter = {
                ...(filter.from !== undefined ? { from: filter.from } : {}),
                resolve,
                reject,
            };
            let timer: ReturnType<typeof setTimeout> | undefined;
            const cleanup = (): void => {
                this.removeWaiter(agentId, waiter);
                if (timer !== undefined) clearTimeout(timer);
                if (signal !== undefined && onAbort !== undefined) {
                    signal.removeEventListener('abort', onAbort);
                }
            };
            let onAbort: (() => void) | undefined;
            if (signal !== undefined) {
                onAbort = () => {
                    cleanup();
                    reject(signal.reason instanceof Error ? signal.reason : new Error('IRC wait aborted'));
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    cleanup();
                    resolve(null);
                }, timeoutMs);
            }
            let bucket = this.waiters.get(agentId);
            if (bucket === undefined) {
                bucket = [];
                this.waiters.set(agentId, bucket);
            }
            bucket.push(waiter);
        });
    }

    private removeWaiter(agentId: string, waiter: IrcWaiter): void {
        const waiters = this.waiters.get(agentId);
        if (waiters === undefined) return;
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        if (waiters.length === 0) this.waiters.delete(agentId);
    }
}

let globalBus: IrcBus | undefined;

/** Process-global bus bound to the process-global registry. */
export function getGlobalIrcBus(): IrcBus {
    if (globalBus === undefined) {
        globalBus = new IrcBus(getRuntimeRegistry());
    }
    return globalBus;
}

/** Reset the global bus. Test-only. */
export function resetGlobalIrcBusForTests(): void {
    if (globalBus !== undefined) {
        globalBus.clear();
    }
    globalBus = undefined;
}

// =============================================================================
// Schema
// =============================================================================

export const ircInputSchema = z
    .object({
        op: z.enum(['send', 'wait', 'inbox', 'list']).describe('irc operation'),
        to: z.string().min(1).optional().describe('send: recipient agent id, or "all" to broadcast'),
        message: z.string().min(1).optional().describe('send: message body'),
        replyTo: z.string().min(1).optional().describe('send: message id being answered'),
        from: z.string().min(1).optional().describe('wait: only accept a message from this agent id'),
        timeoutMs: z.number().int().nonnegative().optional().describe('wait: timeout in ms (0 waits indefinitely)'),
        peek: z.boolean().optional().describe('inbox: list messages without consuming them'),
    })
    .strict();
export type IrcToolInput = z.infer<typeof ircInputSchema>;

const ircReceiptSchema = z
    .object({
        to: z.string().min(1),
        outcome: z.enum(['delivered', 'failed']),
        error: z.string().optional(),
    })
    .strict();

const ircPeerSchema = z
    .object({
        id: z.string().min(1),
        displayName: z.string().min(1),
        kind: z.enum(['main', 'sub', 'advisor']),
        status: z.enum(['running', 'idle', 'parked', 'aborted']),
        parentId: z.string().min(1).optional(),
        unread: z.number().int().nonnegative(),
    })
    .strict();

const ircMessageSchema = z
    .object({
        id: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        body: z.string(),
        ts: z.number(),
        replyTo: z.string().min(1).optional(),
    })
    .strict();

export const ircOutputSchema = z
    .object({
        op: z.enum(['send', 'wait', 'inbox', 'list']),
        from: z.string().min(1).optional(),
        to: z.string().min(1).optional(),
        receipts: z.array(ircReceiptSchema).optional(),
        waited: ircMessageSchema.nullable().optional(),
        inbox: z.array(ircMessageSchema).optional(),
        peers: z.array(ircPeerSchema).optional(),
        error: z.string().optional(),
    })
    .strict();
export type IrcToolOutput = z.infer<typeof ircOutputSchema>;

// =============================================================================
// Tool factory
// =============================================================================

export interface IrcToolOptions {
    /** Caller agent id (the agent invoking the tool). Required. */
    readonly agentId: string;
    /** Registry backing peer lookup. Defaults to the process-global registry. */
    readonly registry?: RuntimeAgentRegistry;
    /** Bus backing routing. Defaults to the process-global bus. */
    readonly bus?: IrcBus;
    /** Config gate. When false (or agentId empty) the factory returns null. */
    readonly enabled?: boolean;
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined) return DEFAULT_IRC_TIMEOUT_MS;
    if (timeoutMs === 0) return 0;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return DEFAULT_IRC_TIMEOUT_MS;
    return Math.max(MIN_IRC_TIMEOUT_MS, Math.trunc(timeoutMs));
}

/**
 * Build the `irc` tool registration. Returns null when disabled or when the caller has no
 * agent id, so the CLI can skip registration without branching.
 */
export function createIrcToolRegistration(
    options: IrcToolOptions,
): ToolRegistration<IrcToolInput, IrcToolOutput> | null {
    const enabled = options.enabled !== false;
    if (!enabled || options.agentId.length === 0) return null;
    const agentId = options.agentId;
    const registry = options.registry ?? getRuntimeRegistry();
    const bus = options.bus ?? getGlobalIrcBus();

    return {
        name: IRC_TOOL_NAME,
        description:
            'Send and receive short prose messages between live agents in this process. ' +
            'SEND delivers to one agent id (or "all" for a broadcast) and is fire-and-forget; ' +
            'WAIT blocks for an incoming message; INBOX drains pending messages; LIST shows ' +
            'addressable peer agents. Messages reach recipients registered in the runtime agent registry.',
        capabilityClasses: ['subagent'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                op: { type: 'string', enum: ['send', 'wait', 'inbox', 'list'] },
                to: { type: 'string', description: 'send: recipient agent id, or "all" to broadcast.' },
                message: { type: 'string', description: 'send: message body.' },
                replyTo: { type: 'string', description: 'send: message id being answered.' },
                from: { type: 'string', description: 'wait: only accept a message from this agent id.' },
                timeoutMs: { type: 'number', description: 'wait: timeout in ms (0 waits indefinitely).' },
                peek: { type: 'boolean', description: 'inbox: list messages without consuming them.' },
            },
            required: ['op'],
            additionalProperties: false,
        },
        inputSchema: ircInputSchema,
        outputSchema: ircOutputSchema,
        outputLimit: IRC_OUTPUT_LIMIT,
        execute: (input, context) => executeIrc({ agentId, registry, bus }, input, context.signal),
        toModelOutput: formatIrcModelOutput,
        guideline:
            'Use to coordinate with concurrent peer agents (siblings spawned by task). SEND is ' +
            'fire-and-forget; pair with WAIT or INBOX on the recipient side. LIST discovers ' +
            'addressable peer ids. Do not message yourself.',
    };
}

interface IrcRuntime {
    readonly agentId: string;
    readonly registry: RuntimeAgentRegistry;
    readonly bus: IrcBus;
}

async function executeIrc(runtime: IrcRuntime, input: IrcToolInput, signal: AbortSignal): Promise<IrcToolOutput> {
    switch (input.op) {
        case 'list':
            return executeList(runtime);
        case 'send':
            return executeSend(runtime, input);
        case 'wait':
            return executeWait(runtime, input, signal);
        case 'inbox':
            return executeInbox(runtime, input);
    }
}

function executeList(runtime: IrcRuntime): IrcToolOutput {
    const peers: IrcPeerInfo[] = runtime.registry
        .listVisibleTo(runtime.agentId)
        .filter((ref) => ref.status !== 'aborted')
        .map((ref) => ({
            id: ref.id,
            displayName: ref.displayName,
            kind: ref.kind,
            status: ref.status,
            ...(ref.parentId !== undefined ? { parentId: ref.parentId } : {}),
            unread: runtime.bus.unreadCount(ref.id),
        }));
    return { op: 'list', from: runtime.agentId, peers };
}

function executeSend(runtime: IrcRuntime, input: IrcToolInput): Promise<IrcToolOutput> {
    const to = input.to?.trim();
    const body = input.message?.trim();
    if (to === undefined || to.length === 0) {
        return Promise.resolve(errorOutput('send', runtime.agentId, '`to` is required for op="send".'));
    }
    if (body === undefined || body.length === 0) {
        return Promise.resolve(errorOutput('send', runtime.agentId, '`message` is required for op="send".'));
    }
    if (to === runtime.agentId) {
        return Promise.resolve(errorOutput('send', runtime.agentId, 'Cannot send an irc message to yourself.', to));
    }
    const targets = to === 'all' ? runtime.registry.listVisibleTo(runtime.agentId).map((ref) => ref.id) : [to];
    if (targets.length === 0) {
        return Promise.resolve({
            op: 'send',
            from: runtime.agentId,
            to,
            receipts: [],
        });
    }
    return Promise.all(
        targets.map((target) =>
            runtime.bus.send({
                from: runtime.agentId,
                to: target,
                body,
                ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
            }),
        ),
    ).then((receipts) => ({ op: 'send', from: runtime.agentId, to, receipts }));
}

async function executeWait(runtime: IrcRuntime, input: IrcToolInput, signal: AbortSignal): Promise<IrcToolOutput> {
    const from = input.from?.trim();
    const timeoutMs = resolveTimeoutMs(input.timeoutMs);
    const waited = await runtime.bus.wait(
        runtime.agentId,
        from !== undefined && from.length > 0 ? { from } : {},
        timeoutMs,
        signal,
    );
    return {
        op: 'wait',
        from: runtime.agentId,
        waited,
    };
}

function executeInbox(runtime: IrcRuntime, input: IrcToolInput): IrcToolOutput {
    const messages = runtime.bus.inbox(runtime.agentId, input.peek !== undefined ? { peek: input.peek } : undefined);
    return {
        op: 'inbox',
        from: runtime.agentId,
        inbox: messages,
    };
}

function errorOutput(op: IrcToolInput['op'], from: string, message: string, to?: string): IrcToolOutput {
    return {
        op,
        from,
        ...(to !== undefined ? { to } : {}),
        error: message,
    };
}

function formatIrcModelOutput(output: IrcToolOutput): string {
    if (output.error !== undefined && (output.receipts === undefined || output.receipts.length === 0)) {
        return output.error;
    }
    switch (output.op) {
        case 'list': {
            const peers = output.peers ?? [];
            if (peers.length === 0) return 'No other agents.';
            const lines = peers.map(
                (peer) =>
                    `- ${peer.id} [${peer.displayName} · ${peer.kind} · ${peer.status}]${
                        peer.unread > 0 ? ` — unread ${peer.unread}` : ''
                    }`,
            );
            return `${peers.length} peer(s):\n${lines.join('\n')}`;
        }
        case 'send': {
            const receipts = output.receipts ?? [];
            if (receipts.length === 0) return 'No live peers to deliver to.';
            const delivered = receipts.filter((receipt) => receipt.outcome !== 'failed');
            if (delivered.length === 0) return 'No recipients received the message.';
            const lines = receipts.map((receipt) =>
                receipt.outcome === 'failed'
                    ? `- ${receipt.to}: failed — ${receipt.error ?? 'unknown error'}`
                    : `- ${receipt.to}: ${receipt.outcome}`,
            );
            return `Delivered to ${delivered.length} peer(s):\n${lines.join('\n')}`;
        }
        case 'wait': {
            const waited = output.waited;
            if (waited === null || waited === undefined) return 'No message arrived within the timeout.';
            const replyTag = waited.replyTo !== undefined ? ` (reply to ${waited.replyTo})` : '';
            return `[${waited.id}] ${waited.from}${replyTag}: ${waited.body}`;
        }
        case 'inbox': {
            const messages = output.inbox ?? [];
            if (messages.length === 0) return 'Inbox empty.';
            const lines = messages.map((message) => {
                const replyTag = message.replyTo !== undefined ? ` (reply to ${message.replyTo})` : '';
                return `- [${message.id}] ${message.from}${replyTag}: ${message.body}`;
            });
            return `${messages.length} message(s):\n${lines.join('\n')}`;
        }
    }
}
