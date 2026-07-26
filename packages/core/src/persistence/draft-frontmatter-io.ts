import { ensureMcDirs, mcFilePath, McPersistenceError } from './paths';
import { isErrorCode } from '../util/node-error';
import { assertValidPlanSlug, PlanFormatError } from './plan-format';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const DRAFT_STATUSES = ['drafting', 'awaiting-approval', 'approved-writing'] as const;
export type DraftScaffoldStatus = (typeof DRAFT_STATUSES)[number];

export type WriteDraftFrontmatterFields = {
    readonly status: DraftScaffoldStatus;
    readonly intent?: string;
    readonly reviewRequired?: boolean;
    readonly pendingAction?: string;
    readonly approach?: string;
};

export type WriteDraftFrontmatterResult = {
    readonly draftPath: string;
    readonly created: boolean;
};

export type DualReviewReceipt = {
    readonly reviewer: string;
    readonly oracle: string;
    readonly verdict: string;
    readonly attempt: number;
};

export type AppendDualReviewReceiptsResult = {
    readonly draftPath: string;
    readonly appended: boolean;
};

export const DUAL_REVIEW_RECEIPTS_HEADING = '## Dual review receipts';

export class DraftFrontmatterError extends McPersistenceError {
    constructor(message: string, code: string, path?: string, cause?: unknown) {
        super(message, code, path, cause);
        this.name = 'DraftFrontmatterError';
    }
}

/**
 * Deterministically write/update YAML frontmatter on `.mc/drafts/<slug>.md`.
 * Preserves any existing body. Creates the draft when missing.
 */
export async function writeDraftFrontmatter(
    workspaceRoot: string,
    slug: string,
    fields: WriteDraftFrontmatterFields,
): Promise<WriteDraftFrontmatterResult> {
    assertDraftSlug(slug);
    const root = await resolveWorkspaceRoot(workspaceRoot);
    const draftPath = mcFilePath(root, 'drafts', `${slug}.md`);
    assertInsideMc(root, draftPath);

    const existing = await readOptionalUtf8(draftPath);
    const body = existing === undefined ? '' : extractDraftBody(existing);
    const created = existing === undefined;
    await ensureMcDirs(root, ['drafts']);
    await atomicWrite(draftPath, `${formatDraftFrontmatterBlock(slug, fields)}${body}`);
    return { draftPath, created };
}

/**
 * Append a dual-review receipt line under `## Dual review receipts` on the draft.
 * Creates the section when missing. Creates a drafting stub when the draft is absent.
 */
export async function appendDualReviewReceipts(
    workspaceRoot: string,
    slug: string,
    receipt: DualReviewReceipt,
): Promise<AppendDualReviewReceiptsResult> {
    assertDraftSlug(slug);
    const root = await resolveWorkspaceRoot(workspaceRoot);
    const draftPath = mcFilePath(root, 'drafts', `${slug}.md`);
    assertInsideMc(root, draftPath);

    const existing = await readOptionalUtf8(draftPath);
    const base =
        existing ??
        formatDraftFrontmatterBlock(slug, {
            status: 'drafting',
        });
    const line = formatDualReviewReceiptLine(receipt);
    const next = appendReceiptSection(base, line);
    if (next === existing) {
        return { draftPath, appended: false };
    }
    await ensureMcDirs(root, ['drafts']);
    await atomicWrite(draftPath, next);
    return { draftPath, appended: true };
}

export function formatDraftFrontmatterBlock(
    slug: string,
    options: {
        readonly status?: DraftScaffoldStatus;
        readonly intent?: string;
        readonly reviewRequired?: boolean;
        readonly pendingAction?: string;
        readonly approach?: string;
    },
): string {
    const status: DraftScaffoldStatus = options.status ?? 'drafting';
    return [
        '---',
        `slug: ${slug}`,
        `status: ${status}`,
        `intent: ${yamlScalar(options.intent ?? '')}`,
        `review_required: ${options.reviewRequired === true ? 'true' : 'false'}`,
        `pending_action: ${yamlScalar(options.pendingAction ?? '')}`,
        `approach: ${yamlScalar(options.approach ?? '')}`,
        '---',
        '',
    ].join('\n');
}

function extractDraftBody(contents: string): string {
    const trimmed = contents.replace(/^\uFEFF/, '');
    if (!trimmed.startsWith('---')) {
        return trimmed;
    }
    const afterOpen = trimmed.slice(3);
    const closeMatch = /\n---\s*(?:\n|$)/u.exec(afterOpen);
    if (closeMatch === null || closeMatch.index === undefined) {
        return trimmed;
    }
    const bodyStart = closeMatch.index + closeMatch[0].length;
    return afterOpen.slice(bodyStart);
}

function formatDualReviewReceiptLine(receipt: DualReviewReceipt): string {
    return `- attempt ${String(receipt.attempt)}: reviewer=${receipt.reviewer}, oracle=${receipt.oracle}, verdict=${receipt.verdict}`;
}

function appendReceiptSection(contents: string, line: string): string {
    if (contents.includes(line)) {
        return contents;
    }
    const headingIndex = contents.indexOf(DUAL_REVIEW_RECEIPTS_HEADING);
    if (headingIndex < 0) {
        const separator = contents.endsWith('\n') || contents.length === 0 ? '' : '\n';
        return `${contents}${separator}\n${DUAL_REVIEW_RECEIPTS_HEADING}\n\n${line}\n`;
    }
    const afterHeading = headingIndex + DUAL_REVIEW_RECEIPTS_HEADING.length;
    const rest = contents.slice(afterHeading);
    const normalizedRest = rest.startsWith('\n') ? rest : `\n${rest}`;
    const nextHeading = normalizedRest.search(/\n## /u);
    if (nextHeading < 0) {
        const body = normalizedRest.endsWith('\n') ? normalizedRest : `${normalizedRest}\n`;
        return `${contents.slice(0, afterHeading)}${body}${line}\n`;
    }
    const beforeNext = normalizedRest.slice(0, nextHeading);
    const afterNext = normalizedRest.slice(nextHeading);
    const padded = beforeNext.endsWith('\n') ? beforeNext : `${beforeNext}\n`;
    return `${contents.slice(0, afterHeading)}${padded}${line}\n${afterNext}`;
}

function assertDraftSlug(slug: string): void {
    try {
        assertValidPlanSlug(slug);
    } catch (error: unknown) {
        if (error instanceof PlanFormatError) {
            throw new DraftFrontmatterError(
                `Invalid plan slug ${JSON.stringify(slug)}: expected lowercase alphanumeric with single-hyphen separators`,
                'plan_scaffold_invalid_slug',
                slug,
                error,
            );
        }
        throw error;
    }
    if (slug.includes('..') || slug.includes(sep) || slug.includes('/') || slug.includes('\\') || isAbsolute(slug)) {
        throw new DraftFrontmatterError(
            `Refusing draft frontmatter for path-escaping slug ${JSON.stringify(slug)}`,
            'plan_scaffold_invalid_slug',
            slug,
        );
    }
}

async function resolveWorkspaceRoot(workspaceRoot: string): Promise<string> {
    if (workspaceRoot.trim().length === 0) {
        throw new DraftFrontmatterError('workspaceRoot must not be empty', 'plan_scaffold_path_escape', workspaceRoot);
    }
    const absolute = isAbsolute(workspaceRoot) ? workspaceRoot : resolve(workspaceRoot);
    try {
        if (!(await stat(absolute)).isDirectory()) {
            throw new DraftFrontmatterError(`workspaceRoot must be a directory: ${absolute}`, 'plan_scaffold_path_escape', absolute);
        }
    } catch (error: unknown) {
        if (error instanceof DraftFrontmatterError) throw error;
        if (isErrorCode(error, 'ENOENT')) return absolute;
        throw new DraftFrontmatterError(`workspaceRoot is not usable: ${absolute}`, 'plan_scaffold_path_escape', absolute, error);
    }
    return absolute;
}

function assertInsideMc(root: string, targetPath: string): void {
    const relativeToMc = relative(mcFilePath(root), targetPath);
    if (relativeToMc === '' || relativeToMc === '..' || relativeToMc.startsWith(`..${sep}`) || isAbsolute(relativeToMc)) {
        throw new DraftFrontmatterError(`Refusing draft path outside .mc/: ${targetPath}`, 'plan_scaffold_path_escape', targetPath);
    }
}

function yamlScalar(value: string): string {
    if (value.length === 0) return '""';
    if (/^[A-Za-z0-9_./:@+-]+$/u.test(value)) return value;
    return JSON.stringify(value);
}

async function readOptionalUtf8(filePath: string): Promise<string | undefined> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) return undefined;
        throw new DraftFrontmatterError(`Failed to read draft at ${filePath}`, 'plan_scaffold_read_failed', filePath, error);
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
        if (error instanceof DraftFrontmatterError) throw error;
        const code = isErrorCode(error, 'ENOTDIR') || isErrorCode(error, 'EEXIST') || isErrorCode(error, 'ENOTSUP')
            ? 'plan_scaffold_path_escape'
            : 'plan_scaffold_write_failed';
        throw new DraftFrontmatterError(`Failed to write draft at ${filePath}`, code, filePath, error);
    } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
    }
}


