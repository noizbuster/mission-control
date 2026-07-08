/** @jsxImportSource @opentui/solid */
import { ErrorBoundary, type JSX } from 'solid-js';

interface AppShellProps {
    readonly children: JSX.Element;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown';
}

function ErrorFallback(props: { readonly error: unknown }): JSX.Element {
    return <text fg="#ff0000">{`Fatal error: ${errorMessage(props.error)}`}</text>;
}

export function AppShell(props: AppShellProps): JSX.Element {
    return <ErrorBoundary fallback={(error) => <ErrorFallback error={error} />}>{props.children}</ErrorBoundary>;
}
