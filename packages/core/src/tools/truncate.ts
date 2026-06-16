/**
 * Centralized tool-output truncation + continuation hints (pi `read.ts`/`truncate.ts` pattern).
 *
 * Tools that can return large outputs (file reads, search, web fetch) route their model-facing
 * string through `truncateOutput` so the context window stays bounded, and append a continuation
 * hint when truncated so the model knows there is more (and how to ask for the next slice).
 */
export type TruncatedOutput = {
    readonly content: string;
    readonly truncated: boolean;
    readonly originalLength: number;
    readonly limit: number;
};

export function truncateOutput(content: string, limit: number): TruncatedOutput {
    if (content.length <= limit) {
        return { content, truncated: false, originalLength: content.length, limit };
    }
    const marker = '\n…[truncated]';
    const sliceLimit = Math.max(0, limit - marker.length);
    return {
        content: `${content.slice(0, sliceLimit)}${marker}`,
        truncated: true,
        originalLength: content.length,
        limit,
    };
}

/**
 * Append a continuation hint when output was truncated, telling the model how to request more.
 * The `resumeHint` is tool-specific (e.g. "call read again with offset=1234").
 */
export function withContinuationHint(output: TruncatedOutput, resumeHint: string): string {
    if (!output.truncated) {
        return output.content;
    }
    return `${output.content}\n[${resumeHint}]`;
}
