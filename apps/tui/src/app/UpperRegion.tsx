/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from 'solid-js';
import { AbgMinimap } from '../components/AbgMinimap.js';
import { bottomDockPolicy } from '../components/chat-bottom-dock-policy.js';
import type { StatusBarProps } from '../components/StatusBar.js';
import { Toast } from '../components/Toast.js';
import { WelcomeScreen } from '../components/WelcomeScreen.js';
import type { AbgOverlayController } from '../state/abg-overlay-controller.js';
import type { WelcomeData } from '../state/welcome-data-types.js';
import { AgentSpinner } from './AgentSpinner.js';
import { basename } from 'node:path';

export type UpperRegionProps = {
    readonly showWelcome: boolean;
    readonly welcomeData: WelcomeData | undefined;
    readonly statusBarProps: StatusBarProps;
    readonly transcript: JSX.Element;
    readonly showAgentIndicator: boolean;
    readonly agentStatusText: string;
    readonly generating: boolean;
    readonly showAbgMinimap: boolean;
    readonly abgOverlayController: AbgOverlayController | undefined;
};

/** Upper output region: welcome or transcript, agent spinner, toast, ABG minimap. */
export function UpperRegion(props: UpperRegionProps): JSX.Element {
    const dimensions = useTerminalDimensions();
    const availableRows = () =>
        bottomDockPolicy({
            columns: dimensions().width,
            rows: dimensions().height,
        }).transcript.rows;

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
            {props.showAgentIndicator && props.agentStatusText.length > 0 ? (
                <AgentSpinner text={props.agentStatusText} />
            ) : props.showAgentIndicator && props.generating ? (
                <AgentSpinner text="Working..." />
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
