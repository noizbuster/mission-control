export type Deferred = {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
};

export class TestInitializationError extends Error {
    readonly name = 'TestInitializationError';
    readonly code = 'test_initialization_failed';
}

export function deferred(): Deferred {
    let resolvePromise = (): void => undefined;
    let rejectPromise = (_error: Error): void => undefined;
    const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}
