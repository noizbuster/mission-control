import type { PromptListControls } from './PromptListPanel';

export const completionPromptListControls = {
    filterable: true,
    selectable: true,
    acceptKeys: ['tab', 'enter'],
    acceptVerb: 'complete',
    dismissible: true,
} as const satisfies PromptListControls;

export const historyPickerPromptListControls = {
    filterable: false,
    selectable: true,
    acceptKeys: ['tab', 'enter'],
    acceptVerb: 'insert',
    dismissible: true,
} as const satisfies PromptListControls;
