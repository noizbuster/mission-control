import { describe, expect, it } from 'vitest';
import {
    type AstGrepCommandExecParams,
    type AstGrepCommandExecResult,
    type AstGrepCommandExecutor,
    AstGrepRunnerError,
    type AstGrepRunOptions,
    type BinaryDetector,
    type BinaryResolution,
    runAstGrep,
} from './ast-grep-runner.js';

const sgBinary: BinaryResolution = { command: 'sg', prefixArgs: [] };

const baseOptions: AstGrepRunOptions = {
    pattern: 'console.log($X)',
    paths: ['src'],
    cwd: '/workspace',
};

describe('runAstGrep', () => {
    it('throws a helpful not_installed error when no ast-grep binary is available', async () => {
        // Given: detector reports no binary
        const detectBinary: BinaryDetector = async () => undefined;

        // When + Then
        await expect(
            runAstGrep(baseOptions, {
                detectBinary,
                execute: assertingExecutor,
            }),
        ).rejects.toThrow(/ast-grep is not installed/);

        try {
            await runAstGrep(baseOptions, { detectBinary, execute: assertingExecutor });
        } catch (error) {
            expect(error).toBeInstanceOf(AstGrepRunnerError);
            assertCode(error, 'not_installed');
        }
    });

    it('parses successful CLI JSON output into structured matches with 1-indexed positions', async () => {
        // Given: CLI returns two matches across two files
        const stdout = JSON.stringify([
            {
                text: "console.log('hi')",
                file: 'src/a.ts',
                range: {
                    start: { line: 4, column: 0 },
                    end: { line: 4, column: 19 },
                },
                metaVariables: { X: "'hi'" },
            },
            {
                text: 'logger.info(msg)',
                file: 'src/b.ts',
                range: {
                    start: { line: 11, column: 2 },
                    end: { line: 11, column: 18 },
                },
            },
        ]);

        // When
        const result = await runAstGrep(baseOptions, {
            detectBinary: detectingDetector(),
            execute: fixedExecutor({ stdout, stderr: '', exitCode: 0 }),
        });

        // Then
        expect(result.matches).toHaveLength(2);
        const first = result.matches[0];
        expect(first?.path).toBe('src/a.ts');
        expect(first?.text).toBe("console.log('hi')");
        expect(first?.startLine).toBe(5);
        expect(first?.startColumn).toBe(1);
        expect(first?.endLine).toBe(5);
        expect(first?.endColumn).toBe(20);
        expect(first?.metaVariables).toEqual({ X: "'hi'" });
        const second = result.matches[1];
        expect(second?.path).toBe('src/b.ts');
        expect(second?.metaVariables).toBeUndefined();
        expect(result.filesWithMatches).toBe(2);
    });

    it('collects stderr parse-error lines into parseErrors without failing the run', async () => {
        // Given: stderr carries file-level parse-error lines; stdout has one good match
        const stderrLines = [
            'src/parse-error.ts: parse error (syntax tree contains error nodes)',
            'WARNING: src/other.ts skipped due to parse error',
            'not-an-error-contextual-log',
        ].join('\n');
        const stdout = JSON.stringify([
            {
                text: 'console.log(x)',
                file: 'src/clean.ts',
                range: { start: { line: 0, column: 0 }, end: { line: 0, column: 14 } },
            },
        ]);

        // When
        const result = await runAstGrep(baseOptions, {
            detectBinary: detectingDetector(),
            execute: fixedExecutor({ stdout, stderr: stderrLines, exitCode: 0 }),
        });

        // Then
        expect(result.matches).toHaveLength(1);
        expect(result.parseErrors).toEqual([
            'src/parse-error.ts: parse error (syntax tree contains error nodes)',
            'WARNING: src/other.ts skipped due to parse error',
        ]);
    });

    it('returns an empty matches array when the CLI produces no matches', async () => {
        // Given: empty JSON array output
        const result = await runAstGrep(baseOptions, {
            detectBinary: detectingDetector(),
            execute: fixedExecutor({ stdout: '[]', stderr: '', exitCode: 0 }),
        });

        // Then
        expect(result.matches).toHaveLength(0);
        expect(result.filesWithMatches).toBe(0);
        expect(result.parseErrors).toBeUndefined();
    });

    it('forwards every path entry as a separate CLI argument when multiple paths are given', async () => {
        // Given: multiple paths and a capturing executor
        const captured = captureExecParams();

        await runAstGrep(
            { ...baseOptions, paths: ['src/lib', 'src/util', 'tests/sample.ts'] },
            {
                detectBinary: detectingDetector(),
                execute: captured.executor,
            },
        );

        // Then: all three paths appear in the trailing args position
        expect(captured.lastArgs()).toEqual([
            'run',
            '--json',
            '--pattern',
            'console.log($X)',
            'src/lib',
            'src/util',
            'tests/sample.ts',
        ]);
    });

    it('injects the --lang flag before the pattern when a language override is supplied', async () => {
        // Given: language override and a capturing executor
        const captured = captureExecParams();

        await runAstGrep(
            { ...baseOptions, language: 'TypeScript' },
            {
                detectBinary: detectingDetector(),
                execute: captured.executor,
            },
        );

        // Then
        expect(captured.lastArgs()).toEqual([
            'run',
            '--json',
            '--lang',
            'TypeScript',
            '--pattern',
            'console.log($X)',
            'src',
        ]);
    });

    it('throws a timed_out error when the executor reports a timeout', async () => {
        // Given: executor returns timedOut=true
        await expect(
            runAstGrep(baseOptions, {
                detectBinary: detectingDetector(),
                execute: fixedExecutor({
                    stdout: '',
                    stderr: '',
                    exitCode: null,
                    timedOut: true,
                    aborted: false,
                }),
                timeoutMs: 250,
            }),
        ).rejects.toThrow(/timed out after 250ms/);

        try {
            await runAstGrep(baseOptions, {
                detectBinary: detectingDetector(),
                execute: fixedExecutor({
                    stdout: '',
                    stderr: '',
                    exitCode: null,
                    timedOut: true,
                    aborted: false,
                }),
            });
        } catch (error) {
            assertCode(error, 'timed_out');
        }
    });

    it('throws a run_failed error with stderr context when the CLI exits non-zero', async () => {
        // Given: executor reports exit code 2 with stderr context
        await expect(
            runAstGrep(baseOptions, {
                detectBinary: detectingDetector(),
                execute: fixedExecutor({
                    stdout: '',
                    stderr: 'pattern syntax error near `$X`',
                    exitCode: 2,
                    timedOut: false,
                    aborted: false,
                }),
            }),
        ).rejects.toThrow(/exited with code 2/);
    });

    it('truncates matches past the match limit and records a truncation notice in parseErrors', async () => {
        // Given: CLI returns 3 matches, limit set to 2
        const stdout = JSON.stringify([matchAt('src/one.ts', 0), matchAt('src/two.ts', 1), matchAt('src/three.ts', 2)]);

        const result = await runAstGrep(baseOptions, {
            detectBinary: detectingDetector(),
            execute: fixedExecutor({ stdout, stderr: '', exitCode: 0 }),
            matchLimit: 2,
        });

        expect(result.matches.map((match) => match.path)).toEqual(['src/one.ts', 'src/two.ts']);
        expect(result.parseErrors).toEqual(['result_truncated: 1 additional match(es) dropped after limit of 2']);
    });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function detectingDetector(resolution: BinaryResolution = sgBinary): BinaryDetector {
    return async () => resolution;
}

function fixedExecutor(outcome: Partial<AstGrepCommandExecResult>): AstGrepCommandExecutor {
    const resolved: AstGrepCommandExecResult = {
        stdout: outcome.stdout ?? '',
        stderr: outcome.stderr ?? '',
        exitCode: outcome.exitCode ?? 0,
        timedOut: outcome.timedOut ?? false,
        aborted: outcome.aborted ?? false,
    };
    return async () => resolved;
}

function captureExecParams(): {
    readonly executor: AstGrepCommandExecutor;
    readonly lastArgs: () => readonly string[];
} {
    let lastArgs: readonly string[] = [];
    const executor: AstGrepCommandExecutor = async (params: AstGrepCommandExecParams) => {
        lastArgs = params.args;
        return {
            stdout: '[]',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            aborted: params.signal.aborted,
        };
    };
    return { executor, lastArgs: () => lastArgs };
}

async function assertingExecutor(): Promise<AstGrepCommandExecResult> {
    throw new Error('executor must not be called when binary detection fails');
}

function matchAt(path: string, line: number): unknown {
    return {
        text: `match-${path}`,
        file: path,
        range: { start: { line, column: 0 }, end: { line, column: 8 } },
    };
}

function assertCode(error: unknown, code: string): void {
    if (error instanceof AstGrepRunnerError) {
        expect(error.code).toBe(code);
        return;
    }
    throw new Error(`expected AstGrepRunnerError, got ${typeof error}`);
}
