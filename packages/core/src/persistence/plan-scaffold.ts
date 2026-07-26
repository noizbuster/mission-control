import {
    DUAL_REVIEW_RECEIPTS_HEADING,
    type DraftScaffoldStatus,
    type DualReviewReceipt,
    type AppendDualReviewReceiptsResult,
    type WriteDraftFrontmatterFields,
    type WriteDraftFrontmatterResult,
    appendDualReviewReceipts,
    formatDraftFrontmatterBlock,
    writeDraftFrontmatter,
} from './draft-frontmatter-io';
import { isErrorCode } from '../util/node-error';
import { McPersistenceError, ensureMcDirs, mcFilePath } from './paths';
import { assertValidPlanSlug, PlanFormatError } from './plan-format';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export {
    DUAL_REVIEW_RECEIPTS_HEADING,
    appendDualReviewReceipts,
    writeDraftFrontmatter,
    type AppendDualReviewReceiptsResult,
    type DraftScaffoldStatus,
    type DualReviewReceipt,
    type WriteDraftFrontmatterFields,
    type WriteDraftFrontmatterResult,
};

/** Title Case scaffold headers for `.mc/plans/<slug>.md` (single source of truth). */
export const PLANNER_SCAFFOLD_HEADERS: readonly string[] = [
    '# <slug> - Work Plan',
    '## TL;DR (For humans)',
    '## Scope',
    '## Verification Strategy',
    '## Execution Strategy',
    '## Todos',
    '## Final Verification Wave',
    '## Commit Strategy',
    '## Success Criteria',
];

export type ScaffoldPlanFilesOptions = {
    readonly status?: DraftScaffoldStatus;
    readonly intent?: string;
    readonly reviewRequired?: boolean;
    readonly pendingAction?: string;
    readonly approach?: string;
};

export type ScaffoldPlanFilesResult = {
    readonly created: boolean;
    readonly reason: 'created' | 'already_scaffolded';
    readonly draftPath: string;
    readonly planPath: string;
};

export class PlanScaffoldError extends McPersistenceError {
    constructor(message: string, code: string, path?: string, cause?: unknown) {
        super(message, code, path, cause !== undefined ? { cause } : undefined);
        this.name = 'PlanScaffoldError';
    }
}

/**
 * Create `.mc/drafts/<slug>.md` frontmatter stub + `.mc/plans/<slug>.md` skeleton.
 * No-op when the plan already has MC scaffold markers. Rejects invalid/escaping slugs.
 */
export async function scaffoldPlanFiles(
    workspaceRoot: string,
    slug: string,
    options: ScaffoldPlanFilesOptions = {},
): Promise<ScaffoldPlanFilesResult> {
    assertScaffoldSlug(slug);
    const root = await resolveWorkspaceRoot(workspaceRoot);
    const draftPath = mcFilePath(root, 'drafts', `${slug}.md`);
    const planPath = mcFilePath(root, 'plans', `${slug}.md`);
    assertInsideMc(root, draftPath);
    assertInsideMc(root, planPath);

    const existingPlan = await readOptionalUtf8(planPath);
    if (existingPlan !== undefined && hasScaffoldMarkers(existingPlan, slug)) {
        return { created: false, reason: 'already_scaffolded', draftPath, planPath };
    }

    await ensureMcDirs(root, ['plans', 'drafts']);
    await atomicWrite(planPath, formatPlanSkeleton(slug));
    if ((await readOptionalUtf8(draftPath)) === undefined) {
        await atomicWrite(draftPath, formatDraftFrontmatterBlock(slug, options));
    }
    return { created: true, reason: 'created', draftPath, planPath };
}

/** Detect existing MC/ulw scaffold markers (headers and/or Status + counted sections). */
export function hasScaffoldMarkers(contents: string, slug?: string): boolean {
    const sections = PLANNER_SCAFFOLD_HEADERS.filter((h) => h.startsWith('## '));
    if (sections.every((h) => contents.includes(h))) {
        return true;
    }
    const hasTodos = contents.includes('## Todos');
    const hasFinalWave = contents.includes('## Final Verification Wave');
    if (!hasTodos || !hasFinalWave) {
        return false;
    }
    if (/^Status:\s*\S+/mu.test(contents)) {
        return true;
    }
    return slug !== undefined && contents.includes(`# ${slug} - Work Plan`);
}

function assertScaffoldSlug(slug: string): void {
    try {
        assertValidPlanSlug(slug);
    } catch (error: unknown) {
        if (error instanceof PlanFormatError) {
            throw new PlanScaffoldError(
                `Invalid plan slug ${JSON.stringify(slug)}: expected lowercase alphanumeric with single-hyphen separators`,
                'plan_scaffold_invalid_slug',
                slug,
                error,
            );
        }
        throw error;
    }
    if (slug.includes('..') || slug.includes(sep) || slug.includes('/') || slug.includes('\\') || isAbsolute(slug)) {
        throw new PlanScaffoldError(
            `Refusing plan scaffold for path-escaping slug ${JSON.stringify(slug)}`,
            'plan_scaffold_invalid_slug',
            slug,
        );
    }
}

async function resolveWorkspaceRoot(workspaceRoot: string): Promise<string> {
    if (workspaceRoot.trim().length === 0) {
        throw new PlanScaffoldError('workspaceRoot must not be empty', 'plan_scaffold_path_escape', workspaceRoot);
    }
    const absolute = isAbsolute(workspaceRoot) ? workspaceRoot : resolve(workspaceRoot);
    try {
        const info = await stat(absolute);
        if (!info.isDirectory()) {
            throw new PlanScaffoldError(
                `workspaceRoot must be a directory: ${absolute}`,
                'plan_scaffold_path_escape',
                absolute,
            );
        }
    } catch (error: unknown) {
        if (error instanceof PlanScaffoldError) throw error;
        if (isErrorCode(error, 'ENOENT')) return absolute;
        throw new PlanScaffoldError(
            `workspaceRoot is not usable: ${absolute}`,
            'plan_scaffold_path_escape',
            absolute,
            error,
        );
    }
    return absolute;
}

function assertInsideMc(root: string, targetPath: string): void {
    const relativeToMc = relative(mcFilePath(root), targetPath);
    if (relativeToMc === '' || relativeToMc === '..' || relativeToMc.startsWith(`..${sep}`) || isAbsolute(relativeToMc)) {
        throw new PlanScaffoldError(
            `Refusing plan scaffold path outside .mc/: ${targetPath}`,
            'plan_scaffold_path_escape',
            targetPath,
        );
    }
}

function formatPlanSkeleton(slug: string): string {
    const lines: string[] = [];
    for (const header of PLANNER_SCAFFOLD_HEADERS) {
        if (header.startsWith('# ')) {
            lines.push(header.replace('<slug>', slug), '', 'Status: Draft', '');
            continue;
        }
        lines.push(header, '');
    }
    return `${lines.join('\n')}\n`;
}

async function readOptionalUtf8(filePath: string): Promise<string | undefined> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) return undefined;
        throw new PlanScaffoldError(
            `Failed to read plan scaffold at ${filePath}`,
            'plan_scaffold_read_failed',
            filePath,
            error,
        );
    }
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(tempPath, contents, { encoding: 'utf8', flag: 'wx' });
        await rename(tempPath, filePath);
    } catch (error: unknown) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        if (error instanceof PlanScaffoldError) throw error;
        if (isErrorCode(error, 'ENOTDIR') || isErrorCode(error, 'EEXIST') || isErrorCode(error, 'ENOTSUP')) {
            throw new PlanScaffoldError(
                `Refusing plan scaffold path escape or invalid workspace root for ${filePath}`,
                'plan_scaffold_path_escape',
                filePath,
                error,
            );
        }
        throw new PlanScaffoldError(
            `Failed to write plan scaffold at ${filePath}`,
            'plan_scaffold_write_failed',
            filePath,
            error,
        );
    } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
    }
}


