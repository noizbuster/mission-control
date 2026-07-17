import type { AstGrepMatch } from './ast-grep-runner';
import type { AstGrepOutput, AstGrepQueryOutput, AstGrepRewriteOutput } from './ast-grep-schemas';

const TRUNCATION_MARKER = 'result_truncated';

export function astGrepModelOutput(output: AstGrepOutput): string {
    return isRewriteOutput(output) ? rewriteModelOutput(output) : queryModelOutput(output);
}

export function hasTruncationNotice(parseErrors: readonly string[] | undefined): boolean {
    return parseErrors?.some((line) => line.startsWith(TRUNCATION_MARKER)) ?? false;
}

function queryModelOutput(output: AstGrepQueryOutput): string {
    if (output.matches.length === 0) {
        const lines = ['ast_grep: no matches found.'];
        appendParseErrors(lines, output.parseErrors);
        return lines.join('\n');
    }
    const header = `ast_grep: ${output.matches.length} match(es) across ${output.filesWithMatches} file(s).`;
    const parts = [header, ...output.matches.map((match) => formatMatch(match))];
    if (output.truncated) parts.push('Result truncated by match limit. Narrow the pattern or paths to see more.');
    appendParseErrors(parts, output.parseErrors);
    return parts.join('\n\n');
}

function rewriteModelOutput(output: AstGrepRewriteOutput): string {
    if (output.proposed === 0) return output.message;
    const plural = output.proposed === 1 ? '' : 's';
    const lines = [`(proposed) ${output.proposed} replacement${plural} across ${output.files} file(s).`];
    for (const entry of output.replacements) lines.push(`  ${entry.path}: ${entry.count}`);
    lines.push('Call resolve(action:"apply") to commit, or resolve(action:"discard") to drop.');
    return lines.join('\n');
}

function isRewriteOutput(output: AstGrepOutput): output is AstGrepRewriteOutput {
    return 'mode' in output && output.mode === 'rewrite';
}

function formatMatch(match: AstGrepMatch): string {
    const lines = [`${match.path}:${match.startLine}:${match.startColumn}: ${match.text}`];
    if (match.metaVariables !== undefined) {
        const entries = Object.entries(match.metaVariables);
        if (entries.length > 0) lines.push(entries.map(([key, value]) => `  ${key}: ${value}`).join('\n'));
    }
    return lines.join('\n');
}

function appendParseErrors(lines: string[], parseErrors: readonly string[] | undefined): void {
    if (parseErrors === undefined || parseErrors.length === 0) return;
    const filtered = parseErrors.filter((line) => !line.startsWith(TRUNCATION_MARKER));
    if (filtered.length > 0) lines.push(filtered.join('\n'));
}
