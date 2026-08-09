/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { For, type JSX, Show } from 'solid-js';
import { useTuiPluginRuntime } from '../platform/providers/plugin-runtime-context';
import { useTuiConfig } from '../platform/providers/runtime-context';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector';
import type { ChatStore, ContextCacheUsage } from '../state/chat-store';
import { OverlayFrame } from './OverlayFrame';

export type DiagnosticsOverlayProps = {
    readonly store: ChatStore;
};

function formatTokens(used: number | undefined, max: number | undefined): string {
    if (used === undefined && max === undefined) return 'n/a';
    if (max === undefined) return `${used ?? 0}`;
    if (used === undefined) return `? / ${max}`;
    const pct = max > 0 ? Math.round((used / max) * 100) : 0;
    return `${used} / ${max} (${pct}%)`;
}

function formatCache(usage: ContextCacheUsage | undefined): string {
    if (usage === undefined) return 'n/a';
    if (usage.inputTokens === 0 && usage.cacheReadTokens === 0) return 'none';
    return `in${usage.inputTokens} hit${usage.cacheReadTokens}`;
}

/**
 * Operator diagnostics panel for recovery lifecycle, context pressure,
 * plugin/keybind faults, and runtime readiness. openConsoleOnError is disabled
 * on the renderer; this is the surface for the same class of information.
 *
 * Always renders explicit OK rows when subsystems are healthy so an empty
 * panel never looks like a broken mount.
 */
export function DiagnosticsOverlay(props: DiagnosticsOverlayProps): JSX.Element {
    const pluginRuntime = useTuiPluginRuntime();
    const config = useTuiConfig();
    const snap = useSolidStoreSelector(props.store, (state) => state);
    const pluginDiagnostics = () => pluginRuntime.diagnostics();
    const keybindDiagnostics = () => config.keybindDiagnostics;

    const contextLine = () => {
        const s = snap();
        return `tokens ${formatTokens(s.contextTokensUsed, s.contextTokensMax)} · cache ${formatCache(s.contextCacheUsage)}`;
    };

    const recoveryLine = () => {
        const s = snap();
        const remount = s.remountCircuitOpen ? 'circuit-open' : `generation ${s.remountGeneration}`;
        const detail = s.lastRemountMessage === undefined ? '' : ` · ${s.lastRemountMessage}`;
        return `remount ${remount}${detail} · parts ${s.transcriptParts.length}`;
    };

    const streamLine = () => {
        const s = snap();
        if (!s.generating) return 'idle';
        if (s.lastStreamActivityAt === undefined) return 'streaming';
        const ageSeconds = Math.round(Math.max(0, Date.now() - s.lastStreamActivityAt) / 1000);
        return `streaming · last activity ${ageSeconds}s ago`;
    };

    return (
        <OverlayFrame
            variant="view"
            title="Diagnostics"
            hint="(Esc or leader+d to close)"
            footer="Recovery · context · keybind · plugins"
        >
            <box flexDirection="column" marginTop={1}>
                <text attributes={TextAttributes.BOLD}>Recovery</text>
                <text attributes={TextAttributes.DIM}>{recoveryLine()}</text>
                <text attributes={TextAttributes.DIM}>{`stream: ${streamLine()}`}</text>
                <Show when={snap().stickyNotice !== null}>
                    <text fg="#fbbf24">{snap().stickyNotice ?? ''}</text>
                </Show>
                <Show when={snap().agentStatusText.length > 0}>
                    <text attributes={TextAttributes.DIM}>{`agent: ${snap().agentStatusText}`}</text>
                </Show>

                <box marginTop={1}>
                    <text attributes={TextAttributes.BOLD}>Context</text>
                </box>
                <text attributes={TextAttributes.DIM}>{contextLine()}</text>
                <text attributes={TextAttributes.DIM}>
                    {`session: ${snap().sessionId.length > 0 ? snap().sessionId : '(none)'} · model: ${snap().currentModelSelection?.providerID ?? '?'}/${snap().currentModelSelection?.modelID ?? '?'}`}
                </text>

                <box marginTop={1}>
                    <text attributes={TextAttributes.BOLD}>Keybind config</text>
                </box>
                <Show
                    when={keybindDiagnostics().length > 0}
                    fallback={<text attributes={TextAttributes.DIM}>ok · no keybind diagnostics</text>}
                >
                    <For each={keybindDiagnostics()}>
                        {(d) => <text attributes={TextAttributes.DIM}>{`[${d.scope}] ${d.message}`}</text>}
                    </For>
                </Show>

                <box marginTop={1}>
                    <text attributes={TextAttributes.BOLD}>Plugins</text>
                </box>
                <Show
                    when={pluginDiagnostics().length > 0}
                    fallback={<text attributes={TextAttributes.DIM}>ok · no plugin diagnostics</text>}
                >
                    <For each={pluginDiagnostics().slice(-20)}>
                        {(d) => (
                            <text attributes={TextAttributes.DIM}>{`[${d.level}] ${d.pluginName}: ${d.code}`}</text>
                        )}
                    </For>
                </Show>
            </box>
        </OverlayFrame>
    );
}
