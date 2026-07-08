/**
 * Tree-sitter capture-name -> terminal style rules for opentui's SyntaxStyle.
 *
 * `buildSyntaxRules()` returns a `readonly ThemeTokenStyle[]` consumed by
 * `SyntaxStyle.fromTheme(rules)`. opentui computes specificity as
 * `scope.split('.').length` and applies base-scope fallback: a `keyword.function`
 * capture with no exact rule falls back to the `keyword` rule, and
 * `markup.heading.3` falls back to `markup.heading`. A sparse table therefore
 * still highlights well, so a dotted variant is only split out when it deserves
 * a DIFFERENT color than its base scope.
 *
 * Scope groups and colors are ported from opencode's `getSyntaxRules(theme)`
 * (sst/opencode `packages/tui/src/theme/index.ts`, commit 5f61d214) but
 * reference this module's {@link darkSyntaxPalette} instead of opencode's theme
 * object. This module imports only the `ThemeTokenStyle` TYPE (erased at
 * runtime), so importing it never touches the native Zig core or spawns the
 * parser worker.
 */

import type { ThemeTokenStyle } from '@opentui/core';

/**
 * Curated dark hex palette for the common tree-sitter capture buckets.
 * Frozen via `as const`; values are referenced directly by the rule table.
 */
export const darkSyntaxPalette = {
    comment: '#637777',
    keyword: '#c792ea',
    function: '#82aaff',
    variable: '#eeffff',
    string: '#c3e88d',
    number: '#f78c6c',
    type: '#ffcb6b',
    operator: '#89ddff',
    punctuation: '#89ddff',
    default: '#eeffff',
} as const;

// Accent hex values outside the base palette. Builtins and tags map to a soft
// red (#f07178) mirroring opencode's theme.error routing; markdown headings and
// links reuse the function blue so they share a single source of truth.
const builtinRed = '#f07178';
const headingBlue = darkSyntaxPalette.function;

/**
 * Build the scope -> style rule table for `SyntaxStyle.fromTheme`.
 *
 * Returns a grouped table: every scope sharing a color/style lives in one
 * {@link ThemeTokenStyle}, and dotted variants are split out only when their
 * color differs from the base scope (relying on opentui's base-scope fallback
 * for the rest). Covers the ~30 most impactful tree-sitter capture groups:
 * default, comments, strings/literals, numbers/constants, keywords, functions,
 * variables/properties, types/modules, operators/punctuation, attributes/tags,
 * markdown markup, and diff hunks.
 */
export function buildSyntaxRules(): readonly ThemeTokenStyle[] {
    return [
        { scope: ['default'], style: { foreground: darkSyntaxPalette.default } },

        // Comments
        {
            scope: ['comment', 'comment.documentation'],
            style: { foreground: darkSyntaxPalette.comment, italic: true },
        },
        {
            scope: ['comment.todo', 'comment.note'],
            style: { foreground: darkSyntaxPalette.comment, italic: true, bold: true },
        },
        {
            scope: ['comment.error'],
            style: { foreground: builtinRed, italic: true, bold: true },
        },
        {
            scope: ['comment.warning'],
            style: { foreground: darkSyntaxPalette.type, italic: true, bold: true },
        },

        // Strings & literals
        {
            scope: ['string', 'string.special', 'symbol', 'character'],
            style: { foreground: darkSyntaxPalette.string },
        },
        {
            scope: ['string.escape', 'string.regexp'],
            style: { foreground: darkSyntaxPalette.keyword },
        },

        // Numbers & constants
        {
            scope: ['number', 'boolean', 'float', 'constant'],
            style: { foreground: darkSyntaxPalette.number },
        },
        { scope: ['constant.builtin'], style: { foreground: builtinRed } },

        // Keywords. The base `keyword` rule (italic magenta) covers
        // return/conditional/repeat/import/export/directive/modifier/exception
        // via base-scope fallback; only keyword sub-scopes with a different
        // color are split out below.
        {
            scope: ['keyword'],
            style: { foreground: darkSyntaxPalette.keyword, italic: true },
        },
        { scope: ['keyword.function'], style: { foreground: darkSyntaxPalette.function } },
        {
            scope: ['keyword.type'],
            style: { foreground: darkSyntaxPalette.type, bold: true, italic: true },
        },
        {
            scope: ['keyword.operator', 'keyword.conditional.ternary'],
            style: { foreground: darkSyntaxPalette.operator },
        },

        // Functions
        {
            scope: ['function', 'constructor', 'function.call', 'function.method'],
            style: { foreground: darkSyntaxPalette.function },
        },
        { scope: ['function.builtin'], style: { foreground: builtinRed } },

        // Variables & properties
        {
            scope: ['variable', 'variable.parameter', 'variable.member', 'property', 'field', 'parameter'],
            style: { foreground: darkSyntaxPalette.variable },
        },
        { scope: ['variable.builtin', 'variable.super'], style: { foreground: builtinRed } },

        // Types & modules
        {
            scope: ['type', 'class', 'module', 'namespace', 'struct'],
            style: { foreground: darkSyntaxPalette.type },
        },
        { scope: ['type.builtin', 'module.builtin'], style: { foreground: builtinRed } },
        { scope: ['type.definition'], style: { foreground: darkSyntaxPalette.type, bold: true } },

        // Operators & punctuation
        {
            scope: ['operator', 'punctuation.delimiter', 'punctuation.bracket', 'tag.delimiter'],
            style: { foreground: darkSyntaxPalette.operator },
        },
        {
            scope: ['punctuation', 'punctuation.special'],
            style: { foreground: darkSyntaxPalette.punctuation },
        },

        // Attributes & tags
        { scope: ['attribute', 'annotation'], style: { foreground: darkSyntaxPalette.keyword } },
        { scope: ['tag'], style: { foreground: builtinRed } },
        { scope: ['tag.attribute'], style: { foreground: darkSyntaxPalette.keyword } },

        // Markdown markup. `markup.heading` covers .1-.6 via base-scope fallback.
        { scope: ['markup.heading'], style: { foreground: headingBlue, bold: true } },
        {
            scope: ['markup.bold', 'markup.strong'],
            style: { foreground: darkSyntaxPalette.default, bold: true },
        },
        { scope: ['markup.italic'], style: { foreground: darkSyntaxPalette.default, italic: true } },
        {
            scope: ['markup.raw', 'markup.raw.block', 'markup.raw.inline'],
            style: { foreground: darkSyntaxPalette.string },
        },
        {
            scope: ['markup.link', 'markup.link.url'],
            style: { foreground: headingBlue, underline: true },
        },
        { scope: ['markup.list'], style: { foreground: darkSyntaxPalette.number } },
        { scope: ['markup.quote'], style: { foreground: darkSyntaxPalette.comment, italic: true } },

        // Diff hunks
        { scope: ['diff.plus'], style: { foreground: darkSyntaxPalette.string } },
        { scope: ['diff.minus'], style: { foreground: builtinRed } },
        { scope: ['diff.delta'], style: { foreground: darkSyntaxPalette.type } },
    ];
}
