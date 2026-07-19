/** @jsxImportSource @opentui/solid */

import { testRender } from '@opentui/solid';
import { type JSX, onMount } from 'solid-js';
import { describe, expect, it } from 'vitest';
import type { StatusBarProps } from '../components/StatusBar';
import type { ClipboardServiceRenderer } from '../platform/clipboard-service';
import {
    MissionControlClipboardToastProviders,
    type TuiToastService,
    useTuiToast,
} from '../platform/providers/clipboard-toast-context';
import type { WelcomeData } from '../state/welcome-data-types';
import { UpperRegion } from './UpperRegion';

const NOTICE = 'Press Ctrl+C again to exit';
const VIEWPORTS = [
    { width: 128, height: 40 },
    { width: 48, height: 24 },
] as const;
const statusBarProps = { providerID: 'local', modelID: 'local-echo' } satisfies StatusBarProps;
const welcomeData = {
    version: '0.1.0',
    defaultModel: { providerID: 'local', modelID: 'local-echo' },
    mcpServers: [],
    projectSkills: [],
    lspServers: [],
    recentSessions: [],
} satisfies WelcomeData;

const testClipboardRenderer: ClipboardServiceRenderer = {
    copyToClipboardOSC52(): boolean {
        return false;
    },
    isOsc52Supported(): boolean {
        return false;
    },
};

function TransientNoticeScenario(props: { readonly onToast: (toast: TuiToastService) => void }): JSX.Element {
    const toast = useTuiToast();
    onMount(() => {
        props.onToast(toast);
        toast.show({ message: NOTICE, variant: 'info', duration: 60_000 });
    });

    return (
        <UpperRegion
            showWelcome
            welcomeData={welcomeData}
            statusBarProps={statusBarProps}
            transcript={<text>prompt-ready transcript</text>}
            showAbgMinimap={false}
            abgOverlayController={undefined}
        />
    );
}

describe('UpperRegion transient notices', () => {
    for (const viewport of VIEWPORTS) {
        it(`paints a mounted transient notice at ${viewport.width}x${viewport.height}`, async () => {
            // Given: a prompt-ready upper region with a transient toast provider.
            let observedToast: TuiToastService | undefined;
            const setup = await testRender(
                () => (
                    <MissionControlClipboardToastProviders useRenderer={() => testClipboardRenderer}>
                        <box width="100%" height="100%" flexDirection="column">
                            <box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
                                <TransientNoticeScenario
                                    onToast={(toast) => {
                                        observedToast = toast;
                                    }}
                                />
                            </box>
                            <box flexShrink={0} width="100%">
                                <text>prompt dock</text>
                            </box>
                        </box>
                    </MissionControlClipboardToastProviders>
                ),
                viewport,
            );

            try {
                // When: the native renderer mounts the upper region and its transient notice.
                await setup.renderOnce();
                const frame = await setup.waitForFrame((candidate) => candidate.includes(NOTICE));

                // Then: provider state and the native terminal frame both expose the notice.
                expect(observedToast?.current()?.message).toBe(NOTICE);
                expect(frame).toContain(NOTICE);
            } finally {
                setup.renderer.destroy();
            }
        });
    }
});
