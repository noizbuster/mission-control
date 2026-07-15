export type Deferred<T> = {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void;
    readonly reject: (reason?: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
    let resolve: Deferred<T>['resolve'] | undefined;
    let reject: Deferred<T>['reject'] | undefined;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    if (resolve === undefined || reject === undefined) {
        throw new Error('deferred initialization failed');
    }
    return { promise, resolve, reject };
}
