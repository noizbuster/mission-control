const settlementQueues = new WeakMap<object, Map<string, Promise<void>>>();

export async function withDesktopApprovalSettlementLock<Result>(
    target: object,
    input: {
        readonly sessionId: string;
        readonly approvalId: string;
    },
    action: () => Promise<Result>,
): Promise<Result> {
    const key = `${input.sessionId}:${input.approvalId}`;
    const queue = queueFor(target);
    const previous = queue.get(key) ?? Promise.resolve();
    let releaseCurrent = () => {};
    const current = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    queue.set(key, next);

    await previous.catch(() => undefined);
    try {
        return await action();
    } finally {
        releaseCurrent();
        if (queue.get(key) === next) {
            queue.delete(key);
        }
        if (queue.size === 0) {
            settlementQueues.delete(target);
        }
    }
}

function queueFor(target: object): Map<string, Promise<void>> {
    const existing = settlementQueues.get(target);
    if (existing !== undefined) {
        return existing;
    }
    const created = new Map<string, Promise<void>>();
    settlementQueues.set(target, created);
    return created;
}
