import { useRenderer } from '@opentui/solid';
import { useTuiToast } from '../platform/providers/index.js';

/**
 * Read-only mouse-up hook: when a drag-selection exists, surface the
 * keyboard-copy hint. The copy itself stays keyboard-only (Ctrl+D).
 */
export function useSelectionMouseUp(): () => void {
    const renderer = useRenderer();
    const toast = useTuiToast();

    return (): void => {
        const selection = renderer.getSelection();
        if (selection === null) return;
        if (selection.getSelectedText().length === 0) return;
        toast.show({ message: 'Copy selection: Ctrl+D', variant: 'info' });
    };
}
