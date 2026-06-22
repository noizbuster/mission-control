/**
 * Steer/queue input delivery management (Task 1.5).
 *
 * Steers coalesce into the active run at the next safe boundary; queued inputs open
 * FIFO future runs one at a time. Both are FIFO per session.
 */

import type { Delivery } from '@mission-control/protocol';

export interface SessionInputRecord {
    readonly inputId: string;
    readonly prompt: string;
    readonly delivery: Delivery;
    readonly admittedAt: number;
}

export class SessionInputDelivery {
    private readonly steers = new Map<string, SessionInputRecord[]>();
    private readonly queued = new Map<string, SessionInputRecord[]>();
    private seq = 0;

    admitInput(sessionId: string, input: { inputId: string; prompt: string }, delivery: Delivery): SessionInputRecord {
        const record: SessionInputRecord = {
            inputId: input.inputId,
            prompt: input.prompt,
            delivery,
            admittedAt: this.seq,
        };
        this.seq += 1;
        const map = delivery === 'steer' ? this.steers : this.queued;
        const existing = map.get(sessionId);
        if (existing === undefined) {
            map.set(sessionId, [record]);
        } else {
            existing.push(record);
        }
        return record;
    }

    /** Drains all steers for a session in FIFO order. */
    promoteSteers(sessionId: string): readonly SessionInputRecord[] {
        const records = this.steers.get(sessionId);
        if (records === undefined) return [];
        this.steers.delete(sessionId);
        return records;
    }

    /** Dequeues the next queued input for a session in FIFO order. */
    promoteNextQueued(sessionId: string): SessionInputRecord | undefined {
        const records = this.queued.get(sessionId);
        if (records === undefined) return undefined;
        const next = records.shift();
        if (records.length === 0) {
            this.queued.delete(sessionId);
        }
        return next;
    }

    pendingSteerCount(sessionId: string): number {
        return this.steers.get(sessionId)?.length ?? 0;
    }

    pendingQueuedCount(sessionId: string): number {
        return this.queued.get(sessionId)?.length ?? 0;
    }
}
