export type HistoryRecallTextarea = {
    readonly setText: (text: string) => void;
    readonly gotoBufferEnd: () => void;
};

/** Synchronize a selected history entry with the native textarea and store mirror. */
export function applyHistoryRecallText(
    textarea: HistoryRecallTextarea | undefined,
    text: string,
    setInputMirror: (text: string) => void,
): void {
    textarea?.setText(text);
    textarea?.gotoBufferEnd();
    setInputMirror(text);
}
