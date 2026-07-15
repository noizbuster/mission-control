import type { Client } from '@libsql/client';
import type { LocalLibsqlWriteTarget } from './local-libsql-db';
import type { LocalLibsqlWriteKey } from './local-libsql-identity';
import { AsyncLocalStorage } from 'node:async_hooks';

export const localDbWriteErrorCodes = ['write_lane_reentrant', 'client_quarantined'] as const;
export type LocalDbWriteErrorCode = (typeof localDbWriteErrorCodes)[number];

export class LocalDbWriteError extends Error {
    readonly name = 'LocalDbWriteError';

    constructor(readonly code: LocalDbWriteErrorCode) {
        super(`Local libSQL write lane rejected acquisition (${code})`);
    }
}

export type LocalLibsqlWriteLane = {
    tail: Promise<void>;
    pending: number;
    quarantineError: LocalDbWriteError | undefined;
};

type BoundLocalLibsqlWriteLane = {
    readonly writeKey: LocalLibsqlWriteKey;
    readonly lane: LocalLibsqlWriteLane;
};

const lanesByClient = new WeakMap<Client, BoundLocalLibsqlWriteLane>();
const heldWriteKeys = new AsyncLocalStorage<Set<LocalLibsqlWriteKey>>();

export function createLocalLibsqlWriteLane(): LocalLibsqlWriteLane {
    return { tail: Promise.resolve(), pending: 0, quarantineError: undefined };
}

export function bindLocalLibsqlWriteLane(target: LocalLibsqlWriteTarget, lane: LocalLibsqlWriteLane): void {
    lanesByClient.set(target.client, { writeKey: target.writeKey, lane });
}

export function runInLocalLibsqlWriteLane<T>(target: LocalLibsqlWriteTarget, write: () => Promise<T>): Promise<T> {
    const binding = bindingFor(target);
    if (binding.lane.quarantineError !== undefined) return Promise.reject(binding.lane.quarantineError);
    const held = heldWriteKeys.getStore();
    if (held?.has(binding.writeKey) === true) {
        return Promise.reject(new LocalDbWriteError('write_lane_reentrant'));
    }
    return enqueueLocalLibsqlWrite(binding, write, held);
}

export function quarantineLocalLibsqlWriteLane(client: Client): LocalDbWriteError {
    const error = new LocalDbWriteError('client_quarantined');
    const binding = lanesByClient.get(client);
    if (binding !== undefined) binding.lane.quarantineError = error;
    return error;
}

export function closeLocalLibsqlAfterWrites(lane: LocalLibsqlWriteLane, close: () => void): void {
    if (lane.pending === 0) {
        close();
        return;
    }
    const scheduledTail = lane.tail;
    void scheduledTail.then(() => {
        if (lane.tail !== scheduledTail) {
            closeLocalLibsqlAfterWrites(lane, close);
            return;
        }
        close();
    });
}

async function enqueueLocalLibsqlWrite<T>(
    binding: BoundLocalLibsqlWriteLane,
    write: () => Promise<T>,
    held: Set<LocalLibsqlWriteKey> | undefined,
): Promise<T> {
    const lane = binding.lane;
    lane.pending++;
    const previous = lane.tail;
    let releaseQueue = (): void => undefined;
    const current = new Promise<void>((resolve) => {
        releaseQueue = resolve;
    });
    const queued = previous.then(() => current);
    lane.tail = queued;
    await previous;

    const nextHeld = new Set(held);
    try {
        if (lane.quarantineError !== undefined) throw lane.quarantineError;
        nextHeld.add(binding.writeKey);
        return await heldWriteKeys.run(nextHeld, write);
    } finally {
        nextHeld.delete(binding.writeKey);
        releaseQueue();
        lane.pending--;
    }
}

function bindingFor(target: LocalLibsqlWriteTarget): BoundLocalLibsqlWriteLane {
    const client: Client = target.client;
    const existing = lanesByClient.get(client);
    if (existing !== undefined) return existing;
    const created = { writeKey: target.writeKey, lane: createLocalLibsqlWriteLane() };
    lanesByClient.set(client, created);
    return created;
}
