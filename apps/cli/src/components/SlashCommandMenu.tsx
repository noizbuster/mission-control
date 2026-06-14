import { Box, Text } from 'ink';
import { createSlashCommandMenuView, formatSlashCommandMenuLines } from '../commands/interactive-chat-command-menu.js';

export type SlashCommandMenuProps = {
    readonly input: string;
    readonly selectedIndex: number;
    readonly commands: readonly { readonly id: string; readonly name: string }[];
};

const maxVisibleCommands = 5;

export function SlashCommandMenu({ input, selectedIndex }: SlashCommandMenuProps): React.ReactElement | null {
    const view = createSlashCommandMenuView(input, { selectedIndex }, maxVisibleCommands);
    if (!view.open) {
        return null;
    }
    const columns = process.stdout.columns ?? 80;
    const lines = formatSlashCommandMenuLines(view, columns);
    return (
        <Box flexDirection="column">
            {lines.map((line) => (
                <Text key={line}>{line}</Text>
            ))}
        </Box>
    );
}
