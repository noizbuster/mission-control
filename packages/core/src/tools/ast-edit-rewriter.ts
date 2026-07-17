import {
    type NativeAstReplaceChange,
    type NativeAstRewriteOptions,
    type NativesClient,
} from '../native/natives-client';

export type AstRewriteFn = (
    pattern: string,
    files: readonly string[],
    opts: { readonly replacement: string; readonly lang?: string },
) => readonly NativeAstReplaceChange[];

export function createDefaultAstRewriter(natives: NativesClient): AstRewriteFn {
    return (pattern, files, opts) => {
        const nativeOpts: NativeAstRewriteOptions = {
            replacement: opts.replacement,
            ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
        };
        const result = natives.astRewrite(pattern, [...files], nativeOpts);
        if (result === null) {
            throw new Error('ast module unavailable: the native addon is missing or predates the ast-rewrite module');
        }
        return result;
    };
}
