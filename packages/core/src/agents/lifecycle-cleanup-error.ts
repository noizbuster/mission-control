export class LifecycleCleanupError extends AggregateError {
    readonly primaryError: unknown;
    readonly suppressedErrors: readonly unknown[];

    constructor(input: {
        readonly name: string;
        readonly message: string;
        readonly primaryError: unknown;
        readonly suppressedError: unknown;
    }) {
        const rootPrimary =
            input.primaryError instanceof LifecycleCleanupError ? input.primaryError.primaryError : input.primaryError;
        const suppressedErrors =
            input.primaryError instanceof LifecycleCleanupError
                ? [...input.primaryError.suppressedErrors, input.suppressedError]
                : [input.suppressedError];
        super([rootPrimary, ...suppressedErrors], input.message);
        this.name = input.name;
        this.primaryError = rootPrimary;
        this.suppressedErrors = suppressedErrors;
    }
}
