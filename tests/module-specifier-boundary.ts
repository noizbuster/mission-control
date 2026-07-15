import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';

type ScannedToken = {
    readonly kind: SyntaxKind;
    readonly value: string;
};

export function findForbiddenModuleSpecifiers(source: string, fileName: string): readonly string[] {
    return collectModuleSpecifiers(source, fileName).filter((specifier) =>
        /^(?:react(?:\/|$)|@mission-control\/(?:cli|desktop|tui)(?:\/|$))|(?:^|\/)apps\/(?:cli|desktop|tui)(?:\/|$)/u.test(
            specifier,
        ),
    );
}

function collectModuleSpecifiers(source: string, fileName: string): readonly string[] {
    const scanner = createScanner(
        true,
        fileName.endsWith('.tsx') ? LanguageVariant.JSX : LanguageVariant.Standard,
        source,
    );
    const tokens: ScannedToken[] = [];
    let previousEnd = -1;
    for (;;) {
        const kind = scanner.scan();
        if (kind === SyntaxKind.EndOfFile) break;
        const tokenStart = scanner.getTokenStart();
        const tokenEnd = scanner.getTokenEnd();
        if (tokenEnd <= previousEnd || tokenEnd <= tokenStart) {
            scanner.resetTokenState(Math.min(source.length, tokenStart + 1));
            previousEnd = tokenStart;
            continue;
        }
        previousEnd = tokenEnd;
        tokens.push({ kind, value: scanner.getTokenValue() });
    }
    return tokens.flatMap((token, index) => moduleSpecifierAt(tokens, index, token));
}

function moduleSpecifierAt(tokens: readonly ScannedToken[], index: number, token: ScannedToken): readonly string[] {
    if (token.kind !== SyntaxKind.StringLiteral) return [];
    const previous = tokens[index - 1];
    if (
        previous?.kind === SyntaxKind.ImportKeyword ||
        (previous?.kind === SyntaxKind.OpenParenToken && isModuleCallTarget(tokens, index - 2)) ||
        (previous?.kind === SyntaxKind.FromKeyword && hasModuleKeywordBefore(tokens, index - 2))
    ) {
        return [token.value];
    }
    return [];
}

function isModuleCallTarget(tokens: readonly ScannedToken[], index: number): boolean {
    const token = tokens[index];
    if (token?.kind === SyntaxKind.ImportKeyword) return true;
    const isRequire =
        token?.kind === SyntaxKind.RequireKeyword ||
        (token?.kind === SyntaxKind.Identifier && token.value === 'require');
    if (!isRequire) return false;
    const separator = tokens[index - 1];
    if (separator?.kind !== SyntaxKind.DotToken && separator?.kind !== SyntaxKind.QuestionDotToken) return true;
    const receiver = tokens[index - 2];
    return (
        (receiver?.kind === SyntaxKind.Identifier || receiver?.kind === SyntaxKind.ModuleKeyword) &&
        receiver.value === 'module'
    );
}

function hasModuleKeywordBefore(tokens: readonly ScannedToken[], startIndex: number): boolean {
    for (let index = startIndex; index >= 0; index--) {
        const kind = tokens[index]?.kind;
        if (kind === SyntaxKind.ImportKeyword || kind === SyntaxKind.ExportKeyword) return true;
        if (isModuleClauseBoundary(kind)) return false;
    }
    return false;
}

function isModuleClauseBoundary(kind: SyntaxKind | undefined): boolean {
    return (
        kind === SyntaxKind.SemicolonToken ||
        kind === SyntaxKind.StringLiteral ||
        kind === SyntaxKind.ConstKeyword ||
        kind === SyntaxKind.LetKeyword ||
        kind === SyntaxKind.VarKeyword ||
        kind === SyntaxKind.FunctionKeyword ||
        kind === SyntaxKind.ClassKeyword
    );
}
