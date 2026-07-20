/** @jsxImportSource @opentui/solid */

import { basename } from 'node:path';
import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from 'solid-js';
import type { AbgOverlayController } from '../state/abg-overlay-controller';
import type { WelcomeData } from '../state/welcome-data-types';
import { AbgMinimap } from '../components/AbgMinimap';
import { bottomDockPolicy } from '../components/chat-bottom-dock-policy';
import type { StatusBarProps } from '../components/StatusBar';
import { Toast } from '../components/Toast';
import { WelcomeScreen } from '../components/WelcomeScreen';

export type UpperRegionProps = {
    readonly showWelcome: boolean;
    readonly welcomeData: WelcomeData | undefined;
    readonly statusBarProps: StatusBarProps;
    readonly transcript: JSX.Element;
    readonly showAbgMinimap: boolean;
    readonly abgOverlayController: AbgOverlayController | undefined;
    readonly stickyNotice?: string | null;
};

/** Upper output region: welcome or transcript, agent spinner, toast, ABG minimap. */
export function UpperRegion(props: UpperRegionProps): JSX.Element {
    const dimensions = useTerminalDimensions();
    const availableRows = () =>
        bottomDockPolicy({
            columns: dimensions().width,
            rows: dimensions().height,
        }).transcript.rows;
    const stickyNotice = () => props.stickyNotice ?? null;

    return (
        <box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
            <box flexDirection="column" flexGrow={1} minHeight={0}>
                {props.showWelcome && props.welcomeData !== undefined ? (
                    <WelcomeScreen
                        data={props.welcomeData}
                        viewportColumns={dimensions().width}
                        availableRows={availableRows()}
                        {...(props.statusBarProps.workspaceRoot !== undefined
                            ? { projectLabel: basename(props.statusBarProps.workspaceRoot) }
                            : {})}
                        {...(props.statusBarProps.gitBranch !== undefined
                            ? { gitBranch: props.statusBarProps.gitBranch }
                            : {})}
                        {...(props.statusBarProps.isWorktree !== undefined
                            ? { isWorktree: props.statusBarProps.isWorktree }
                            : {})}
                    />
                ) : (
                    props.transcript
                )}
            </box>
            {stickyNotice() !== null ? (
                <box flexShrink={0} width="100%" paddingLeft={1} paddingRight={1}>
                    <text fg="#fbbf24">{stickyNotice()}</text>
                </box>
            ) : null}
            <Toast />
            {props.showAbgMinimap && props.abgOverlayController !== undefined ? (
                <AbgMinimap
                    store={props.abgOverlayController.store}
                    viewport={{ columns: dimensions().width, rows: dimensions().height }}
                />
            ) : null}
        </box>
    );
}
