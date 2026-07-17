import { describe, expect, it } from 'vitest';
import type { AstGrepMatch } from './ast-grep-runner';
import { type AstGrepOutput, astGrepParametersJsonSchema } from './ast-grep-schemas';
import { type AstGrepToolOptions, createAstGrepToolRegistration, registerAstGrepTool } from './ast-grep-tool';
import { ToolRegistry } from './tool-registry';

describe('ast_grep tool registration', () => {
    const baseOptions: AstGrepToolOptions = { workspaceRoot: '/workspace' };

    it('produces a valid ToolRegistration with the ast_grep identity', () => {
        const registration = createAstGrepToolRegistration(baseOptions);

        expect(registration.name).toBe('ast_grep');
        expect(registration.capabilityClasses).toContain('read');
        expect(registration.description).toContain('ast-grep');
        expect(registration.outputLimit.maxModelOutputChars).toBe(8000);
        expect(registration.guideline).toContain('ast_grep');
    });

    it('exposes the ast_grep parameters JSON schema', () => {
        const registration = createAstGrepToolRegistration(baseOptions);

        expect(registration.parametersJsonSchema).toEqual(astGrepParametersJsonSchema());
    });

    it('binds input and output schemas from the shared contract', () => {
        const registration = createAstGrepToolRegistration(baseOptions);

        expect(registration.inputSchema.safeParse({ pattern: 'console.log($X)', paths: ['src'] }).success).toBe(true);
        expect(registration.inputSchema.safeParse({ pattern: '', paths: ['src'] }).success).toBe(false);
        expect(registration.inputSchema.safeParse({ pattern: 'x', paths: [] }).success).toBe(false);
        expect(
            registration.outputSchema.safeParse({
                matches: [],
                filesSearched: 0,
                filesWithMatches: 0,
                truncated: false,
            }).success,
        ).toBe(true);
    });

    it('registers and advertises the ast_grep name with read capability', async () => {
        const registry = new ToolRegistry();

        const advertisement = await registerAstGrepTool(registry, baseOptions);

        expect(advertisement.name).toBe('ast_grep');
        expect(advertisement.capabilityClasses).toContain('read');
        expect(advertisement.outputLimit.maxModelOutputChars).toBe(8000);
        const advertised = registry.advertise().find((tool) => tool.name === 'ast_grep');
        expect(advertised?.capabilityClasses).toContain('read');
    });
});

describe('ast_grep model output', () => {
    const registration = createAstGrepToolRegistration({ workspaceRoot: '/workspace' });

    it('formats each match with a file:line:col prefix and metaVariables', () => {
        const output: AstGrepOutput = {
            matches: [
                {
                    path: 'src/a.ts',
                    text: "console.log('hi')",
                    startLine: 5,
                    startColumn: 1,
                    endLine: 5,
                    endColumn: 20,
                    metaVariables: { X: "'hi'" },
                },
                {
                    path: 'src/b.ts',
                    text: 'logger.info(msg)',
                    startLine: 12,
                    startColumn: 3,
                    endLine: 12,
                    endColumn: 19,
                },
            ],
            filesSearched: 2,
            filesWithMatches: 2,
            truncated: false,
        };

        const modelOutput = registration.toModelOutput?.(output) ?? '';

        expect(modelOutput).toContain("src/a.ts:5:1: console.log('hi')");
        expect(modelOutput).toContain("X: 'hi'");
        expect(modelOutput).toContain('src/b.ts:12:3: logger.info(msg)');
        expect(modelOutput).toContain('2 match(es)');
    });

    it('reports an empty result set without crashing', () => {
        const modelOutput =
            registration.toModelOutput?.({
                matches: [],
                filesSearched: 0,
                filesWithMatches: 0,
                truncated: false,
            }) ?? '';

        expect(modelOutput.length).toBeGreaterThan(0);
        expect(modelOutput).toContain('no matches');
    });

    it('includes a truncation notice when the result was truncated', () => {
        const modelOutput =
            registration.toModelOutput?.({
                matches: [matchAt('src/one.ts', 5)],
                filesSearched: 1,
                filesWithMatches: 1,
                truncated: true,
            }) ?? '';

        expect(modelOutput).toContain('truncated');
    });
});

function matchAt(path: string, line: number): AstGrepMatch {
    return {
        path,
        text: `match-${path}`,
        startLine: line,
        startColumn: 1,
        endLine: line,
        endColumn: 10,
    };
}
