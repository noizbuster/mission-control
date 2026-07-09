/** @jsxImportSource @opentui/solid */

import { basename } from 'node:path';
import type { JSX } from 'solid-js';
import type { TerminalViewport } from '../platform/terminal-viewport.js';
import type { AbgOverlayController } from '../state/abg-overlay-controller.js';
import type { WelcomeData } from '../state/welcome-data-types.js';
import { AbgMinimap } from '../components/AbgMinimap.js';
import type { StatusBarProps } from '../components/StatusBar.js';
import { Toast } from '../components/Toast.js';
import { WelcomeScreen } from '../components/WelcomeScreen.js';
import { AgentSpinner } from './AgentSpinner.js';

export type UpperRegionProps = {
    readonly showWelcome: boolean;
    readonly welcomeData: WelcomeData | undefined;
    readonly viewport: TerminalViewport;
    readonly availableRows: number;
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
    return (
        <box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
            <box flexDirection="column" flexGrow={1} minHeight={0}>
                {props.showWelcome && props.welcomeData !== undefined ? (
                    <WelcomeScreen
                        data={props.welcomeData}
                        viewportColumns={props.viewport.columns}
                        availableRows={props.availableRows}
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
                <AbgMinimap store={props.abgOverlayController.store} viewport={props.viewport} />
            ) : null}
        </box>
    );
}
