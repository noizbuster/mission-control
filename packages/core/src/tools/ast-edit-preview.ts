import type { NativeAstReplaceChange } from '../native/natives-client';
import type { AstEditOutput, AstEditReplacement } from './ast-edit-schemas';
import { relative } from 'node:path';

export function summarizeAstEditReplacements(
    changes: readonly NativeAstReplaceChange[],
    workspaceRoot: string,
): readonly AstEditReplacement[] {
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const change of changes) {
        const relativePath = toRelative(workspaceRoot, change.path);
        if (!counts.has(relativePath)) {
            order.push(relativePath);
            counts.set(relativePath, 0);
        }
        counts.set(relativePath, (counts.get(relativePath) ?? 0) + 1);
    }
    return order.map((path) => ({ path, count: counts.get(path) ?? 0 }));
}

export function noAstEditMatchResult(): AstEditOutput {
    return {
        proposed: 0,
        files: 0,
        replacements: [],
        staged: false,
        message: 'ast_edit: no replacements proposed. Nothing staged for resolve.',
    };
}

export function formatAstEditModelOutput(output: AstEditOutput): string {
    if (output.proposed === 0) return output.message;
    const plural = output.proposed === 1 ? '' : 's';
    const lines = [`(proposed) ${output.proposed} replacement${plural} across ${output.files} file(s).`];
    for (const entry of output.replacements) lines.push(`  ${entry.path}: ${entry.count}`);
    lines.push('Call resolve(action:"apply") to commit, or resolve(action:"discard") to drop.');
    return lines.join('\n');
}

function toRelative(workspaceRoot: string, absolutePath: string): string {
    const relativePath = relative(workspaceRoot, absolutePath);
    return relativePath.length === 0 ? absolutePath : relativePath;
}
