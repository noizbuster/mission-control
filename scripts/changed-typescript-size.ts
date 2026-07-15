import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_CHANGED_TYPESCRIPT_PURE_LOC = 250;
const ZERO_GITHUB_SHA = /^0{40}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/iu;
const ATTRIBUTED_SIZE_OK_COMMENT =
    /^[ \t]*\/\/[ \t]+allow:[ \t]+SIZE_OK[ \t]+-{1,2}[ \t]+HEAD[ \t]+[0-9]+[ \t]+->[ \t]+current[ \t]+~?([0-9]+)[ \t]+pure[ \t]+LOC;[ \t]+([ -~]{24,})[ \t]*$/u;

export type ChangedTypeScriptSize = {
    readonly file: string;
    readonly pureLoc: number;
    readonly exempt: boolean;
};

export class ChangedTypeScriptBaseError extends Error {
    readonly name = 'ChangedTypeScriptBaseError';
    readonly base: string;

    constructor(base: string) {
        super(`invalid changed TypeScript base SHA: ${base}`);
        this.base = base;
    }
}

export class ChangedTypeScriptArgumentError extends Error {
    readonly name = 'ChangedTypeScriptArgumentError';

    constructor() {
        super('usage: pnpm check:changed-ts-size -- [--base <sha>]');
    }
}

export function countPureLoc(source: string): number {
    return source.split(/\r?\n/u).filter((line) => !/^\s*$/u.test(line) && !/^\s*(?:\/\/|#|--)/u.test(line)).length;
}

export function hasAttributedSizeOk(source: string, pureLoc: number): boolean {
    return source.split(/\r?\n/u).some((line) => {
        const match = ATTRIBUTED_SIZE_OK_COMMENT.exec(line);
        const currentLoc = match?.[1];
        const reason = match?.[2];
        return (
            currentLoc !== undefined &&
            reason !== undefined &&
            Number(currentLoc) === pureLoc &&
            reason.trim().length >= 24
        );
    });
}

export function inspectChangedTypeScript(root: string, base?: string): readonly ChangedTypeScriptSize[] {
    return changedTypeScriptFiles(root, base).map((file) => {
        const source = readFileSync(resolve(root, file), 'utf8');
        const pureLoc = countPureLoc(source);
        return {
            file,
            pureLoc,
            exempt: hasAttributedSizeOk(source, pureLoc),
        };
    });
}

export function changedTypeScriptSizeViolations(
    records: readonly ChangedTypeScriptSize[],
): readonly ChangedTypeScriptSize[] {
    return records.filter((record) => record.pureLoc > MAX_CHANGED_TYPESCRIPT_PURE_LOC && !record.exempt);
}

export function formatChangedTypeScriptSizeReport(records: readonly ChangedTypeScriptSize[]): string {
    const violations = changedTypeScriptSizeViolations(records);
    if (violations.length === 0) {
        return 'changed TypeScript size gate: 0 unapproved overages';
    }
    return [
        `changed TypeScript size gate: ${violations.length} unapproved overage(s)`,
        ...violations.map((record) => `${record.pureLoc}\t${record.file}`),
    ].join('\n');
}

function changedTypeScriptFiles(root: string, base?: string): readonly string[] {
    const comparisonBase = resolveComparisonBase(root, base);
    const committed = gitPaths(root, [
        'diff',
        '--name-only',
        '-z',
        '--diff-filter=ACMR',
        comparisonBase,
        'HEAD',
        '--',
        '*.ts',
        '*.tsx',
    ]);
    const workingTree = gitPaths(root, [
        'diff',
        '--name-only',
        '-z',
        '--diff-filter=ACMR',
        'HEAD',
        '--',
        '*.ts',
        '*.tsx',
    ]);
    const untracked = gitPaths(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', '*.ts', '*.tsx']);
    return [...new Set([...committed, ...workingTree, ...untracked])]
        .filter((file) => isAuditedTypeScript(file) && isRegularFile(resolve(root, file)))
        .sort((left, right) => left.localeCompare(right));
}

function resolveComparisonBase(root: string, explicitBase?: string): string {
    const { MCTRL_CHANGED_TS_BASE: environmentBase } = process.env;
    const configuredBase = explicitBase ?? environmentBase;
    if (configuredBase === undefined || configuredBase.trim().length === 0) return 'HEAD';
    const requestedBase = configuredBase.trim();
    if (ZERO_GITHUB_SHA.test(requestedBase)) {
        return tryGitLine(root, ['rev-parse', '--verify', 'HEAD^']) ?? emptyTreeHash(root);
    }
    if (
        !GIT_SHA.test(requestedBase) ||
        tryGitLine(root, ['rev-parse', '--verify', `${requestedBase}^{commit}`]) === undefined
    ) {
        throw new ChangedTypeScriptBaseError(requestedBase);
    }
    const mergeBase = tryGitLine(root, ['merge-base', 'HEAD', requestedBase]);
    if (mergeBase === undefined) throw new ChangedTypeScriptBaseError(requestedBase);
    return mergeBase;
}

function gitPaths(root: string, args: readonly string[]): readonly string[] {
    const output = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    return output.split('\0').filter((path) => path.length > 0);
}

function tryGitLine(root: string, args: readonly string[]): string | undefined {
    try {
        const output = execFileSync('git', args, {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return output.split(/\r?\n/u).find((line) => line.length > 0);
    } catch (error: unknown) {
        if (error instanceof Error) {
            return undefined;
        }
        throw error;
    }
}

function emptyTreeHash(root: string): string {
    return execFileSync('git', ['hash-object', '-t', 'tree', '--stdin'], {
        cwd: root,
        encoding: 'utf8',
        input: '',
    }).trim();
}

function isAuditedTypeScript(file: string): boolean {
    if (!/\.tsx?$/u.test(file) || file.endsWith('.md.ts')) {
        return false;
    }
    return !/(^|\/)(?:dist|build|target|coverage|generated|node_modules|\.nx)(?:\/|$)/u.test(file);
}

function isRegularFile(path: string): boolean {
    try {
        return lstatSync(path).isFile();
    } catch (error: unknown) {
        if (error instanceof Error) return false;
        throw error;
    }
}

function main(): void {
    const root = process.cwd();
    const argumentBase = parseChangedTypeScriptBaseArgument(process.argv.slice(2));
    const records = inspectChangedTypeScript(root, argumentBase);
    const report = formatChangedTypeScriptSizeReport(records);
    process.stdout.write(`${report}\n`);
    if (changedTypeScriptSizeViolations(records).length > 0) {
        process.exitCode = 1;
    }
}

export function parseChangedTypeScriptBaseArgument(args: readonly string[]): string | undefined {
    const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
    if (normalizedArgs.length === 0) return undefined;
    const first = normalizedArgs[0];
    if (normalizedArgs.length === 1 && first?.startsWith('--base=') === true && first.length > '--base='.length) {
        return first.slice('--base='.length);
    }
    if (normalizedArgs.length === 2 && first === '--base' && normalizedArgs[1]?.length !== 0) {
        return normalizedArgs[1];
    }
    throw new ChangedTypeScriptArgumentError();
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
    main();
}
