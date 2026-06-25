/** @jsxImportSource @opentui/react */
import { toOpenTuiAttributes } from '../platform/opentui-types.js';

export type TextInputProps = {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly onSubmit: (value: string) => void;
    readonly placeholder?: string;
    readonly prefix?: string;
};

const defaultPrefix = '> ';

export function TextInput({ value, placeholder, prefix = defaultPrefix }: TextInputProps): React.ReactNode {
    const showPlaceholder = value.length === 0 && placeholder !== undefined;
    return (
        <text>
            {prefix}
            <text {...toOpenTuiAttributes({ dimColor: showPlaceholder })}>
                {showPlaceholder ? placeholder : value}
            </text>
        </text>
    );
}
