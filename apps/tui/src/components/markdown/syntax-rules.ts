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
 * Scope groups and colors are aligned with OpenCode's default `opencode` theme
 * (`ref/opencode/packages/tui/src/theme/assets/opencode.json` dark steps) and
 * `getSyntaxRules(theme)` in `packages/tui/src/theme/index.ts`. OpenTUI's native
 * `<markdown>` looks up `markup.*` scopes (not `markdown.*`); code fences use
 * tree-sitter capture scopes via the same SyntaxStyle.
 *
 * This module imports only the `ThemeTokenStyle` TYPE (erased at runtime), so
 * importing it never touches the native Zig core or spawns the parser worker.
 */

import type { ThemeTokenStyle } from '@opentui/core';

/**
 * OpenCode-aligned dark hex palette for syntax + markdown markup buckets.
 * Values mirror `opencode.json` dark defs (darkStep*, darkAccent, darkRed, …).
 */
export const darkSyntaxPalette = {
    /** darkStep12 — body / punctuation / code-block base. */
    default: '#eeeeee',
    /** darkStep11 — comments / muted chrome. */
    comment: '#808080',
    /** darkAccent — keywords / markdown headings. */
    keyword: '#9d7cd8',
    /** darkStep9 (primary) — functions / links / list markers. */
    function: '#fab283',
    /** darkRed — variables. */
    variable: '#e06c75',
    /** darkGreen — strings / inline code. */
    string: '#7fd88f',
    /** darkOrange — numbers / strong. */
    number: '#f5a742',
    /** darkYellow — types / emphasis / block quotes. */
    type: '#e5c07b',
    /** darkCyan — operators / link labels. */
    operator: '#56b6c2',
    /** darkStep12 — punctuation (same as default text). */
    punctuation: '#eeeeee',
} as const;

/** darkRed — builtins/tags (OpenCode routes these through theme.error). */
const builtinRed = '#e06c75';

/** darkStep9 — markdown headings share the primary accent with functions. */
const headingAccent = darkSyntaxPalette.function;

/** darkAccent — keyword/heading purple from opencode.json. */
const headingPurple = darkSyntaxPalette.keyword;

/**
 * Build the scope -> style rule table for `SyntaxStyle.fromTheme`.
 *
 * Covers tree-sitter capture groups plus every `markup.*` name OpenTUI's
 * MarkdownRenderable looks up (`markup.heading`, `markup.strong`, `markup.raw`,
 * `markup.link.label`, …) and a `conceal` style for fence/marker chrome.
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

        // Keywords
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

        // Markdown markup — names must match OpenTUI MarkdownRenderable lookups.
        {
            scope: ['markup.heading'],
            style: { foreground: headingPurple, bold: true },
        },
        {
            scope: ['markup.heading.1'],
            style: { foreground: headingPurple, bold: true, underline: true },
        },
        {
            scope: ['markup.heading.2', 'markup.heading.3', 'markup.heading.4', 'markup.heading.5', 'markup.heading.6'],
            style: { foreground: headingPurple, bold: true },
        },
        {
            scope: ['markup.bold', 'markup.strong'],
            style: { foreground: darkSyntaxPalette.number, bold: true },
        },
        {
            scope: ['markup.italic'],
            style: { foreground: darkSyntaxPalette.type, italic: true },
        },
        {
            scope: ['markup.strikethrough'],
            style: { foreground: darkSyntaxPalette.comment },
        },
        {
            scope: ['markup.list'],
            style: { foreground: headingAccent },
        },
        {
            scope: ['markup.quote'],
            style: { foreground: darkSyntaxPalette.type, italic: true },
        },
        {
            scope: ['markup.raw', 'markup.raw.block', 'markup.raw.inline'],
            style: { foreground: darkSyntaxPalette.string },
        },
        {
            scope: ['markup.link'],
            style: { foreground: headingAccent, underline: true },
        },
        {
            scope: ['markup.link.label'],
            style: { foreground: darkSyntaxPalette.operator, underline: true },
        },
        {
            scope: ['markup.link.url'],
            style: { foreground: darkSyntaxPalette.comment, underline: true },
        },

        // Fence/marker chrome color used by MarkdownRenderable for borders.
        {
            scope: ['conceal'],
            style: { foreground: darkSyntaxPalette.comment },
        },

        // Diff hunks (tree-sitter diff grammar + Diff renderable base styles)
        { scope: ['diff.plus'], style: { foreground: '#4fd6be' } },
        { scope: ['diff.minus'], style: { foreground: '#c53b53' } },
        { scope: ['diff.delta'], style: { foreground: darkSyntaxPalette.type } },
    ];
}
