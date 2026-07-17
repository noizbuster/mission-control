import { hasTruncationNotice } from './ast-grep-output';
import type { AstGrepResult, AstGrepRunOptions } from './ast-grep-runner';
import { runAstGrep } from './ast-grep-runner';
import type { AstGrepInput, AstGrepQueryOutput } from './ast-grep-schemas';
import { ToolExecutionError } from './tool-registry';

export type AstGrepRunnerFn = (options: AstGrepRunOptions) => Promise<AstGrepResult>;

export async function executeAstGrepQuery(
    input: AstGrepInput,
    context: { readonly signal: AbortSignal },
    options: { readonly workspaceRoot: string; readonly runner?: AstGrepRunnerFn },
): Promise<AstGrepQueryOutput> {
    const runner: AstGrepRunnerFn = options.runner ?? runAstGrep;
    const runOptions: AstGrepRunOptions = {
        pattern: input.pattern,
        paths: input.paths,
        ...(input.language !== undefined ? { language: input.language } : {}),
        cwd: options.workspaceRoot,
        signal: context.signal,
    };
    try {
        const result = await runner(runOptions);
        return {
            matches: result.matches,
            filesSearched: result.filesSearched,
            filesWithMatches: result.filesWithMatches,
            truncated: hasTruncationNotice(result.parseErrors),
            ...(result.parseErrors !== undefined && result.parseErrors.length > 0
                ? { parseErrors: result.parseErrors }
                : {}),
        };
    } catch (error: unknown) {
        if (error instanceof ToolExecutionError) throw error;
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `ast_grep failed: ${errorMessage(error)}`,
            retryable: true,
        });
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
