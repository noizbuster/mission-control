import type { ModelProviderSelection } from '@mission-control/protocol';
import { formatModelSelection } from './interactive-chat-model.js';

export function formatModelProviderStatus(
    selection: ModelProviderSelection,
    options: { readonly nodeMode?: string } = {},
): string {
    const lines = [
        `provider: ${selection.providerID}`,
        `model: ${selection.modelID}`,
        `selection: ${formatModelSelection(selection)}`,
    ];
    if (options.nodeMode !== undefined) {
        lines.push(`node mode: ${options.nodeMode}`);
    }
    return `${lines.join('\n')}\n`;
}
