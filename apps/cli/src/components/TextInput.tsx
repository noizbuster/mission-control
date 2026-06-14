import { Text } from 'ink';

export type TextInputProps = {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly onSubmit: (value: string) => void;
    readonly placeholder?: string;
    readonly prefix?: string;
};

const defaultPrefix = '> ';

export function TextInput({
    value,
    placeholder,
    prefix = defaultPrefix,
}: TextInputProps): React.ReactElement {
    const showPlaceholder = value.length === 0 && placeholder !== undefined;
    return (
        <Text>
            {prefix}
            <Text dimColor={showPlaceholder}>{showPlaceholder ? placeholder : value}</Text>
        </Text>
    );
}
