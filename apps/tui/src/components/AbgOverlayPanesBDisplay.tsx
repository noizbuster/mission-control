/** @jsxImportSource @opentui/solid */

import type { JSX } from 'solid-js';
import {
    type AbgOverlayPaneProps,
    type CostPolicyPaneProps,
    ApprovalsPane as RawApprovalsPane,
    BlackboardPane as RawBlackboardPane,
    CostPolicyPane as RawCostPolicyPane,
    TimelinePane as RawTimelinePane,
    ToolsPane as RawToolsPane,
} from './AbgOverlayPanesB';
import { projectAbgPaneBStateForDisplay, sanitizeAbgDisplayText } from './abg-display-projection';

export function ToolsPane(props: AbgOverlayPaneProps): JSX.Element {
    return <RawToolsPane {...props} state={projectAbgPaneBStateForDisplay(props.state)} />;
}

export function TimelinePane(props: AbgOverlayPaneProps): JSX.Element {
    return <RawTimelinePane {...props} state={projectAbgPaneBStateForDisplay(props.state)} />;
}

export function ApprovalsPane(props: AbgOverlayPaneProps): JSX.Element {
    return <RawApprovalsPane {...props} state={projectAbgPaneBStateForDisplay(props.state)} />;
}

export function CostPolicyPane(props: CostPolicyPaneProps): JSX.Element {
    return (
        <RawCostPolicyPane
            {...props}
            state={projectAbgPaneBStateForDisplay(props.state)}
            {...(props.modelLabel === undefined ? {} : { modelLabel: sanitizeAbgDisplayText(props.modelLabel) })}
        />
    );
}

export function BlackboardPane(props: AbgOverlayPaneProps): JSX.Element {
    return <RawBlackboardPane {...props} state={projectAbgPaneBStateForDisplay(props.state)} />;
}
