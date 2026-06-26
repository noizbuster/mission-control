/** @jsxImportSource @opentui/react */
import { createSlashCommandMenuView } from '../commands/interactive-chat-command-menu.js';

export type SlashCommandMenuProps = {
    readonly input: string;
    readonly selectedIndex: number;
    readonly commands: readonly { readonly id: string; readonly name: string }[];
};

const maxVisibleCommands = 5;
const selectedBg = '#0000ff';
const selectedFg = '#ffffff';

export function SlashCommandMenu({ input, selectedIndex }: SlashCommandMenuProps): React.ReactNode {
    const view = createSlashCommandMenuView(input, { selectedIndex }, maxVisibleCommands);
    if (!view.open) {
        return null;
    }
    const header = view.query.length > 0 ? `Commands matching "${view.query}"` : 'Commands';
    const selectedStyle =
        selectedBg !== undefined && selectedFg !== undefined ? { bg: selectedBg, fg: selectedFg } : {};
    return (
        <box flexDirection="column">
            <text>{header}</text>
            {view.empty ? (
                <text>  no commands match</text>
            ) : (
                view.visibleChoices.map((choice, index) => {
                    const selected = view.startIndex + index === view.selectedIndex;
                    return (
                        <text key={choice.id} {...(selected ? selectedStyle : {})}>
                            {`${selected ? '>' : ' '} ${choice.id}  ${choice.description}`}
                        </text>
                    );
                })
            )}
        </box>
    );
}
