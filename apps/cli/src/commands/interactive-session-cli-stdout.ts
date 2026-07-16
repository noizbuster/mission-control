/** stdout dump after interactive session; empty when OpenTUI already owned the display. */
export function interactiveSessionCliStdout(options: {
    readonly tuiOwnedDisplay: boolean;
    readonly getOutput?: () => string;
}): string {
    if (options.tuiOwnedDisplay) {
        return '';
    }
    return options.getOutput?.() ?? '';
}
