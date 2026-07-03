import { describe, expect, it } from 'vitest';
import type { AgentRef } from '../agents/runtime-registry.js';
import { RuntimeAgentRegistry } from '../agents/runtime-registry.js';
import { createIrcToolRegistration, IRC_TOOL_NAME, IrcBus, type IrcToolInput, type IrcToolOutput } from './irc-tool.js';
import type { ToolRegistration } from './tool-registry-types.js';

type AdoptInput = Omit<AgentRef, 'createdAt' | 'lastActivity'>;

function makeRef(id: string, overrides: Partial<AdoptInput> = {}): AdoptInput {
    return {
        id,
        displayName: id,
        kind: 'sub',
        status: 'running',
        sessionId: `session-${id}`,
        ...overrides,
    };
}

function ctx(): { toolCallId: string; toolName: string; signal: AbortSignal } {
    return { toolCallId: 'call-1', toolName: IRC_TOOL_NAME, signal: new AbortController().signal };
}

interface Fixture {
    readonly registry: RuntimeAgentRegistry;
    readonly bus: IrcBus;
    readonly alpha: ToolRegistration<IrcToolInput, IrcToolOutput>;
    readonly beta: ToolRegistration<IrcToolInput, IrcToolOutput>;
}

function fixture(): Fixture {
    const registry = new RuntimeAgentRegistry();
    registry.adopt(makeRef('Alpha'));
    registry.adopt(makeRef('Beta'));
    const bus = new IrcBus(registry);
    const alpha = createIrcToolRegistration({ agentId: 'Alpha', registry, bus });
    const beta = createIrcToolRegistration({ agentId: 'Beta', registry, bus });
    if (alpha === null || beta === null) throw new Error('irc registrations must not be null in fixture');
    return { registry, bus, alpha, beta };
}

async function send(tool: ToolRegistration<IrcToolInput, IrcToolOutput>, input: IrcToolInput): Promise<IrcToolOutput> {
    return tool.execute(input, ctx());
}

describe('irc tool — config gate', () => {
    it('returns a registration when enabled with an agent id', () => {
        const registry = new RuntimeAgentRegistry();
        const reg = createIrcToolRegistration({ agentId: 'X', registry, bus: new IrcBus(registry) });
        expect(reg).not.toBeNull();
        expect(reg?.name).toBe(IRC_TOOL_NAME);
        expect(reg?.capabilityClasses).toEqual(['subagent']);
    });

    it('returns null when enabled is false', () => {
        const registry = new RuntimeAgentRegistry();
        const reg = createIrcToolRegistration({ agentId: 'X', registry, bus: new IrcBus(registry), enabled: false });
        expect(reg).toBeNull();
    });

    it('returns null when the agent id is empty', () => {
        const registry = new RuntimeAgentRegistry();
        const reg = createIrcToolRegistration({ agentId: '', registry, bus: new IrcBus(registry) });
        expect(reg).toBeNull();
    });
});

describe('irc tool — routing between live children', () => {
    it('routes a message from one live child to another via inbox (mailbox path)', async () => {
        const { alpha, beta } = fixture();

        const sendResult = await send(alpha, { op: 'send', to: 'Beta', message: 'are you touching auth.ts?' });
        expect(sendResult.op).toBe('send');
        expect(sendResult.receipts).toEqual([{ to: 'Beta', outcome: 'delivered' }]);

        const inboxResult = await send(beta, { op: 'inbox' });
        expect(inboxResult.inbox).toHaveLength(1);
        const message = inboxResult.inbox?.[0];
        expect(message?.from).toBe('Alpha');
        expect(message?.to).toBe('Beta');
        expect(message?.body).toBe('are you touching auth.ts?');
    });

    it('routes a message by resolving a pending wait from the recipient (waiter path)', async () => {
        const { alpha, beta } = fixture();

        // Beta parks on a wait; the waiter is registered synchronously before the first await
        // suspends, so sending after kicking the wait resolves it.
        const waitPromise = send(beta, { op: 'wait', from: 'Alpha', timeoutMs: 5000 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await send(alpha, { op: 'send', to: 'Beta', message: 'ready?' });
        const waited = await waitPromise;

        expect(waited.op).toBe('wait');
        expect(waited.waited).not.toBeNull();
        expect(waited.waited?.from).toBe('Alpha');
        expect(waited.waited?.body).toBe('ready?');
    });

    it('wait returns null on timeout when no message arrives', async () => {
        const { beta } = fixture();
        const result = await send(beta, { op: 'wait', timeoutMs: 10 });
        expect(result.waited).toBeNull();
    });

    it('inbox is empty after a consume and peek does not consume', async () => {
        const { alpha, beta } = fixture();
        await send(alpha, { op: 'send', to: 'Beta', message: 'one' });

        const peeked = await send(beta, { op: 'inbox', peek: true });
        expect(peeked.inbox).toHaveLength(1);

        const drained = await send(beta, { op: 'inbox' });
        expect(drained.inbox).toHaveLength(1);

        const empty = await send(beta, { op: 'inbox' });
        expect(empty.inbox).toEqual([]);
    });

    it('carries replyTo through delivery', async () => {
        const { alpha, beta } = fixture();
        await send(alpha, { op: 'send', to: 'Beta', message: 'reply please', replyTo: 'msg-1' });
        const result = await send(beta, { op: 'inbox' });
        expect(result.inbox?.[0]?.replyTo).toBe('msg-1');
    });
});

describe('irc tool — list', () => {
    it('lists peer agents visible to the caller, excluding self and aborted', async () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeRef('Alpha'));
        registry.adopt(makeRef('Beta'));
        registry.adopt(makeRef('Gamma', { status: 'aborted' }));
        const bus = new IrcBus(registry);
        const alpha = createIrcToolRegistration({ agentId: 'Alpha', registry, bus });
        if (alpha === null) throw new Error('alpha registration null');

        const result = await send(alpha, { op: 'list' });
        // Beta is visible; Gamma is aborted so filtered; self excluded.
        expect(result.peers?.map((peer) => peer.id)).toEqual(['Beta']);
        expect(result.peers?.[0]?.unread).toBe(0);
    });

    it('reports unread count from buffered mail', async () => {
        const { alpha, beta } = fixture();
        await send(alpha, { op: 'send', to: 'Beta', message: 'a' });
        await send(alpha, { op: 'send', to: 'Beta', message: 'b' });
        const result = await send(alpha, { op: 'list' });
        expect(result.peers?.find((peer) => peer.id === 'Beta')?.unread).toBe(2);
    });
});

describe('irc tool — send validation', () => {
    it('rejects sending to yourself', async () => {
        const { alpha } = fixture();
        const result = await send(alpha, { op: 'send', to: 'Alpha', message: 'hi me' });
        expect(result.error).toContain('yourself');
    });

    it('fails the receipt for an unknown recipient', async () => {
        const { alpha } = fixture();
        const result = await send(alpha, { op: 'send', to: 'Ghost', message: 'hello' });
        expect(result.receipts).toEqual([
            { to: 'Ghost', outcome: 'failed', error: expect.stringContaining('Unknown or terminated') },
        ]);
    });

    it('broadcasts to all visible peers with to="all"', async () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeRef('Alpha'));
        registry.adopt(makeRef('Beta'));
        registry.adopt(makeRef('Gamma'));
        const bus = new IrcBus(registry);
        const alpha = createIrcToolRegistration({ agentId: 'Alpha', registry, bus });
        if (alpha === null) throw new Error('alpha null');

        const result = await send(alpha, { op: 'send', to: 'all', message: 'standby' });
        expect(result.receipts?.map((receipt) => receipt.to).sort()).toEqual(['Beta', 'Gamma']);
        expect(result.receipts?.every((receipt) => receipt.outcome === 'delivered')).toBe(true);
    });

    it('requires to and message for send', async () => {
        const { alpha } = fixture();
        const noTo = await send(alpha, { op: 'send', message: 'x' });
        expect(noTo.error).toContain('`to`');
        const noMessage = await send(alpha, { op: 'send', to: 'Beta' });
        expect(noMessage.error).toContain('`message`');
    });
});

describe('irc tool — model output', () => {
    it('formats an empty peer list', async () => {
        const registry = new RuntimeAgentRegistry();
        registry.adopt(makeRef('Solo'));
        const bus = new IrcBus(registry);
        const solo = createIrcToolRegistration({ agentId: 'Solo', registry, bus });
        if (solo === null) throw new Error('null');
        const result = await send(solo, { op: 'list' });
        expect(solo.toModelOutput?.(result)).toBe('No other agents.');
    });

    it('formats a delivered send receipt', async () => {
        const { alpha } = fixture();
        const result = await send(alpha, { op: 'send', to: 'Beta', message: 'hi' });
        const text = alpha.toModelOutput?.(result) ?? '';
        expect(text).toContain('Delivered to 1 peer(s)');
        expect(text).toContain('Beta: delivered');
    });

    it('formats a waited message', async () => {
        const { alpha, beta } = fixture();
        const waitPromise = send(beta, { op: 'wait', timeoutMs: 5000 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await send(alpha, { op: 'send', to: 'Beta', message: 'ping' });
        const result = await waitPromise;
        const text = beta.toModelOutput?.(result) ?? '';
        expect(text).toContain('Alpha: ping');
    });
});
