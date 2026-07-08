import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const tuiSourceRoot = 'apps/tui/src';
const guardFilePath = 'apps/tui/src/no-react-deps.test.ts';
const testFilePattern = /\.(test|spec)\.(ts|tsx)$/u;

const forbiddenReactTerms = [
    "from 'react'",
    'from "react"',
    '@opentui/react',
    '@opentui/keymap/react',
    '@types/react',
    '@jsxImportSource @opentui/react',
    'React.',
    'ReactNode',
    'RefObject',
    'createRef',
    'memo(',
    'useSyncExternalStore',
    'Children',
    'createElement',
    'isValidElement',
] as const;

type ReactFinding = {
    readonly file: string;
    readonly term: string;
};

function collectProductSourceFiles(dir: string): string[] {
    const absoluteDir = join(root, dir);
    const files: string[] = [];
    for (const entry of readdirSync(absoluteDir)) {
        const relativePath = join(dir, entry);
        const absolutePath = join(root, relativePath);
        const stat = statSync(absolutePath);
        if (stat.isDirectory()) {
            files.push(...collectProductSourceFiles(relativePath));
            continue;
        }
        if (testFilePattern.test(entry)) continue;
        if (relativePath === guardFilePath) continue;
        if (absolutePath.endsWith('.ts') || absolutePath.endsWith('.tsx')) {
            files.push(relativePath);
        }
    }
    return files.sort();
}

function scanSourceForReact(file: string, source: string): ReactFinding[] {
    return forbiddenReactTerms.flatMap((term) => (source.includes(term) ? [{ file, term }] : []));
}

function scanFilesForReact(files: readonly string[]): ReactFinding[] {
    return files.flatMap((file) => scanSourceForReact(file, readFileSync(join(root, file), 'utf8')));
}

function formatFindings(findings: readonly ReactFinding[]): string {
    return findings.map((finding) => `${finding.file}: forbidden React term "${finding.term}"`).join('\n');
}

describe('apps/tui React dependency removal guard', () => {
    it('scanner flags useSyncExternalStore in a synthetic source fixture', () => {
        const findings = scanSourceForReact('synthetic-fixture.ts', 'export const hook = useSyncExternalStore;');

        expect(findings).toEqual([{ file: 'synthetic-fixture.ts', term: 'useSyncExternalStore' }]);
    });

    it('no product file under apps/tui/src contains React dependency terms', () => {
        const findings = scanFilesForReact(collectProductSourceFiles(tuiSourceRoot));

        expect(findings, `TUI product source must not contain React dependencies\n${formatFindings(findings)}`).toEqual(
            [],
        );
    });
});
