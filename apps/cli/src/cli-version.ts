/**
 * CLI product version — kept out of the entrypoint module so interactive
 * runtime paths can read it without re-importing `index.tsx`.
 *
 * Re-importing the entrypoint while its top-level `await runCli()` is still
 * evaluating creates an ESM cycle that drains the event loop and exits with
 * Node's unsettled top-level-await status (13).
 */
export function getVersion(): string {
    return '0.1.0';
}
