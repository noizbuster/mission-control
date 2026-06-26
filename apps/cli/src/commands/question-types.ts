/**
 * Labeled option for the `ask_user` overlay. `description` renders as dim
 * subtext beneath the label. Mirrors `AskUserOption` without crossing the
 * package boundary for a TUI-only value.
 */
export type QuestionOption = {
    readonly label: string;
    readonly description?: string;
};

/**
 * Normalize legacy `string[]` or labeled `{ label, description? }` options.
 * The conditional `description` spread honors `exactOptionalPropertyTypes`
 * by never emitting an explicit `undefined`.
 */
export function normalizeQuestionOptions(options: readonly (string | QuestionOption)[]): readonly QuestionOption[] {
    return options.map((option) => {
        if (typeof option === 'string') {
            return { label: option };
        }
        return {
            label: option.label,
            ...(option.description !== undefined ? { description: option.description } : {}),
        };
    });
}
