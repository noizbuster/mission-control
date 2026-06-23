/**
 * Streaming markdown healer + block splitter.
 *
 * Assistant text arrives token-by-token, so mid-stream the buffer frequently
 * holds an unclosed ``` fence, a half-typed `**bold`, or a table missing its
 * separator row. `remend` heals the trailing partial markdown; the splitter
 * isolates a trailing open code fence so it renders as raw code instead of
 * swallowing the content that follows it.
 *
 * Ported from opencode's `markdown-stream.ts`, adapted to this repo's strict
 * TypeScript (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `lib: ES2022`):
 * imports split by `verbatimModuleSyntax`, the array tail scan uses a manual
 * loop (ES2023 `findLastIndex` is outside the pinned `lib`), and `remend`
 * failures fall back to one unhealed live block instead of throwing.
 */

import type { Tokens } from 'marked';
import { marked } from 'marked';
import remend from 'remend';

export type Block = {
    readonly raw: string;
    readonly src: string;
    readonly mode: 'full' | 'live';
};

/** Detects a reference link / footnote definition (`[id]: url` or `[^id]:`). */
function refs(text: string): boolean {
    return /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text);
}

/**
 * True when `raw` opens a fenced code block that is never closed.
 *
 * The opening fence mark (```` ``` ```` or `~~~`) is found at the start; if the
 * last non-empty line is not a closer built from the same character with at
 * least the opening length, the fence is still open.
 */
function open(raw: string): boolean {
    const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (!match) return false;
    const mark = match[1];
    if (!mark) return false;
    const char = mark[0];
    if (!char) return false;
    const size = mark.length;
    const last = raw.trimEnd().split('\n').at(-1)?.trim() ?? '';
    return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last);
}

/** Heals partial markdown via remend, rendering incomplete links as text-only. */
function heal(text: string): string {
    return remend(text, { linkMode: 'text-only' });
}

/**
 * Splits streaming markdown into renderable blocks.
 *
 * - `live === false`: the whole text is one `full` block.
 * - `live === true`: the text is healed; reference-link text short-circuits to
 *   one block; otherwise `marked.lexer` tokenizes it and a trailing
 *   unterminated code fence is split off into its own raw block so it renders as
 *   code instead of leaking into following content.
 *
 * Never throws: if `remend` rejects the input, the whole text is returned as a
 * single unhealed `live` block.
 */
export function streamBlocks(text: string, live: boolean): Block[] {
    if (!live) return [{ raw: text, src: text, mode: 'full' }];

    let src: string;
    try {
        src = heal(text);
    } catch {
        return [{ raw: text, src: text, mode: 'live' }];
    }

    if (refs(text)) return [{ raw: text, src, mode: 'live' }];

    const tokens = marked.lexer(text);
    let tail = -1;
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
        if (tokens[i]?.type !== 'space') {
            tail = i;
            break;
        }
    }
    if (tail < 0) return [{ raw: text, src, mode: 'live' }];

    const last = tokens[tail];
    if (!last || last.type !== 'code') return [{ raw: text, src, mode: 'live' }];

    const code = last as Tokens.Code;
    if (!open(code.raw)) return [{ raw: text, src, mode: 'live' }];

    const head = tokens
        .slice(0, tail)
        .map((token) => token.raw)
        .join('');
    if (!head) return [{ raw: code.raw, src: code.raw, mode: 'live' }];

    return [
        { raw: head, src: heal(head), mode: 'live' },
        { raw: code.raw, src: code.raw, mode: 'live' },
    ];
}
