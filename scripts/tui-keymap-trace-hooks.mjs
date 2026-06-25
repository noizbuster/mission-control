// ESM resolve hook for the --no-tui module-graph trace.
//
// Runs in Node's loader thread (shares stderr with the main thread). Every
// resolved module URL is tagged and written to stderr so the parent process
// can capture the full module graph via `2>stderr`.
//
// Loaded via `module.register()` from trace-register.mjs (--import preload).
export async function resolve(specifier, context, nextResolve) {
    const result = await nextResolve(specifier, context);
    try {
        process.stderr.write(`[mctrl-graph] ${result.url}\n`);
    } catch {
        // stderr is best-effort; never let tracing break module loading.
    }
    return result;
}
