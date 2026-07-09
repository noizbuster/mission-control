/** @jsxImportSource @opentui/solid */

import { basename } from 'node:path';
import type { JSX } from 'solid-js';
import type { TerminalViewport } from '../../platform/terminal-viewport.js';
import type { AbgOverlayController } from '../../state/abg-overlay-controller.js';
import type { WelcomeData } from '../../state/welcome-data-types.js';
import { AbgMinimap } from '../AbgMinimap.js';
import type { StatusBarProps } from '../StatusBar.js';
import { Toast } from '../Toast.js';
import { WelcomeScreen } from '../WelcomeScreen.js';
import { AgentSpinner } from './AgentSpinner.js';

export type ChatUpperRegionProps = {
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

/**
 * Upper output region: welcome or transcript, agent spinner, toast, ABG minimap.
 */
export function ChatUpperRegion(props: ChatUpperRegionProps): JSX.Element {
    const bar = props.statusBarProps;

    return (
        <>
            {props.showWelcome && props.welcomeData !== undefined ? (
                <WelcomeScreen
                    data={props.welcomeData}
                    viewportColumns={props.viewport.columns}
                    availableRows={props.availableRows}
                    {...(bar.workspaceRoot !== undefined ? { projectLabel: basename(bar.workspaceRoot) } : {})}
                    {...(bar.gitBranch !== undefined ? { gitBranch: bar.gitBranch } : {})}
                    {...(bar.isWorktree !== undefined ? { isWorktree: bar.isWorktree } : {})}
                />
            ) : (
                props.transcript
            )}
            {props.showAgentIndicator && props.agentStatusText.length > 0 ? (
                <AgentSpinner text={props.agentStatusText} />
            ) : props.showAgentIndicator && props.generating ? (
                <AgentSpinner text="Working..." />
            ) : null}
            <Toast />
            {props.showAbgMinimap && props.abgOverlayController !== undefined ? (
                <AbgMinimap store={props.abgOverlayController.store} viewport={props.viewport} />
            ) : null}
        </>
    );
}
