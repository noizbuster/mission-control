import { redactCredentialText } from '@mission-control/core';

const TITLE_LENGTH_LIMIT = 100;
const PROMPT_TITLE_PREFIX_LIMIT = 97;
const TITLE_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const TITLE_WHITESPACE_CONTROLS = /[\t\n\v\f\r\u0085]/gu;
const TITLE_UNSAFE_CONTROLS = /\p{Cc}/gu;
const TITLE_BIDI_CONTROLS = /\p{Bidi_Control}/gu;

export function normalizeSessionPromptTitle(prompt: string): string {
    return truncateTitle(sanitizeTitleText(redactCredentialText(prompt)));
}

export function cleanGeneratedSessionTitle(output: string): string {
    const withoutReasoning = output.replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, '');
    const firstLine = withoutReasoning
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
    return firstLine === undefined ? '' : truncateTitle(sanitizeTitleText(redactCredentialText(firstLine)));
}

function truncateTitle(value: string): string {
    const graphemes = Array.from(TITLE_SEGMENTER.segment(value), (entry) => entry.segment);
    return graphemes.length <= TITLE_LENGTH_LIMIT
        ? value
        : `${graphemes.slice(0, PROMPT_TITLE_PREFIX_LIMIT).join('')}...`;
}

function sanitizeTitleText(value: string): string {
    return value
        .replace(TITLE_WHITESPACE_CONTROLS, ' ')
        .replace(TITLE_UNSAFE_CONTROLS, '')
        .replace(TITLE_BIDI_CONTROLS, '')
        .replace(/\s+/gu, ' ')
        .trim();
}
