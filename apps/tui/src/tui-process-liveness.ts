const TUI_PROCESS_LIVENESS_DELAY_MS = 2 ** 31 - 1;

/**
 * Retains a referenced Node timer while the OpenTUI renderer is mounted.
 *
 * OpenTUI receives input through native callbacks, which do not retain Node's
 * event loop. Without a referenced handle, an idle interactive session can
 * terminate its top-level await with Node exit status 13.
 */
export function retainTuiProcessLiveness(): () => void {
    const timer = setInterval(() => {}, TUI_PROCESS_LIVENESS_DELAY_MS);
    return () => {
        clearInterval(timer);
    };
}
