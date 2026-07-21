import { SyntaxStyle } from '@opentui/core';
import { buildSyntaxRules } from './syntax-rules';

let cached: SyntaxStyle | undefined;

export function getSharedSyntaxStyle(): SyntaxStyle {
    if (cached !== undefined) return cached;
    try {
        cached = SyntaxStyle.fromTheme([...buildSyntaxRules()]);
    } catch {
        cached = SyntaxStyle.create();
    }
    return cached;
}

/** Production counterpart to {@link resetSharedSyntaxStyleForTest}: called on TUI unmount so mount/unmount cycles in a long-lived process do not accumulate native SyntaxStyle handles. */
export function destroySharedSyntaxStyle(): void {
    if (cached === undefined) return;
    try {
        cached.destroy();
    } catch {
        void 0;
    }
    cached = undefined;
}

export function resetSharedSyntaxStyleForTest(): void {
    if (cached === undefined) return;
    try {
        cached.destroy();
    } catch {
        void 0;
    }
    cached = undefined;
}
