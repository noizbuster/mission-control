/** @jsxImportSource @opentui/react */
import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Error boundary + context wrapper for the opentui render path.
 *
 * Mirrors Ink's behavior where an unmounting renderer cleans up the terminal:
 * when a descendant throws, this boundary catches it, writes the stack to
 * stderr (opentui owns stdout), and renders a red fallback `<text>` so the
 * user sees the error before the process exits.
 *
 * The per-file `@jsxImportSource @opentui/react` pragma loads the opentui JSX
 * namespace so lowercase intrinsics (`<text>`) typecheck. At runtime the
 * opentui jsx-runtime re-exports React's `jsx`/`jsxs` unchanged, so the
 * compiled output is identical to React's automatic runtime.
 */

interface AppShellProps {
    readonly children: ReactNode;
}

interface AppShellState {
    readonly hasError: boolean;
    readonly error?: Error;
}

export class AppShell extends Component<AppShellProps, AppShellState> {
    constructor(props: AppShellProps) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError(error: Error): AppShellState {
        return { hasError: true, error };
    }

    override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        process.stderr.write(`AppShell caught: ${error.message}\n${errorInfo.componentStack ?? ''}\n`);
    }

    override render(): ReactNode {
        if (this.state.hasError) {
            return <text fg="#ff0000">{`Fatal error: ${this.state.error?.message ?? 'unknown'}`}</text>;
        }
        return this.props.children;
    }
}
