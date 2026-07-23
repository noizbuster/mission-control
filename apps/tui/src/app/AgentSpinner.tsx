/** @jsxImportSource @opentui/solid */

import { createEffect, createSignal, type JSX, onCleanup } from 'solid-js';
import { useSpinnerFrame } from '../components/spinner';
import { formatAgentRetryCountdown } from './agent-retry-countdown';

export function AgentSpinner(props: { readonly text: string; readonly retryAt: number | undefined }): JSX.Element {
    const { glyph } = useSpinnerFrame();
    const [now, setNow] = createSignal(Date.now());
    createEffect(() => {
        const retryAt = props.retryAt;
        setNow(Date.now());
        if (retryAt === undefined) return;
        const interval = setInterval(() => {
            const nextNow = Date.now();
            setNow(nextNow);
            if (nextNow >= retryAt) clearInterval(interval);
        }, 1_000);
        onCleanup(() => clearInterval(interval));
    });
    const displayText = (): string => {
        const countdown = props.retryAt === undefined ? undefined : formatAgentRetryCountdown(props.retryAt, now());
        return countdown === undefined ? props.text : `${props.text} · ${countdown}`;
    };
    return (
        <box marginTop={1} flexShrink={0}>
            <text fg="#00ffff">{`${glyph()} ${displayText()}`}</text>
        </box>
    );
}
