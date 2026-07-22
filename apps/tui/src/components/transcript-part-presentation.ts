import type { TranscriptPart, TranscriptPartStatus } from '../state/transcript-part';

export type TranscriptPartPresentation = {
    readonly type: TranscriptPart['type'];
    readonly title: string;
    readonly lines: readonly string[];
    readonly streaming: boolean;
};

type DetailLinesInput = {
    readonly text: string;
    readonly detail?: string | undefined;
    readonly extra?: string | undefined;
};

type PresentationContent = {
    readonly title: string;
    readonly lines: readonly string[];
    readonly status?: TranscriptPartStatus | undefined;
};

export function transcriptContentWidth(viewportColumns: number, insets: number): number {
    return Math.max(1, viewportColumns - insets);
}

export function isTranscriptPartStreaming(status: TranscriptPartStatus | undefined): boolean {
    return status === 'streaming';
}

export function isFinalLegacyPartStreaming(generating: boolean, isLast: boolean): boolean {
    return generating && isLast;
}

export function buildFencedCodeMarkdown(code: string, language: string | undefined): string {
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1));
    const safeLanguage = safeCodeLanguage(language);
    return `${fence}${safeLanguage ?? ''}\n${code}\n${fence}`;
}

const EXTENSION_LANGUAGE_MAP: Readonly<Record<string, string>> = {
    ts: 'typescript',
    tsx: 'tsx',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    py: 'python',
    pyi: 'python',
    rs: 'rust',
    go: 'go',
    rb: 'ruby',
    md: 'markdown',
    markdown: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    css: 'css',
    scss: 'css',
    less: 'css',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'xml',
    sql: 'sql',
    toml: 'toml',
    ini: 'ini',
    cfg: 'ini',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    swift: 'swift',
    dart: 'dart',
    lua: 'lua',
    php: 'php',
    vim: 'vim',
    dockerfile: 'dockerfile',
    graphql: 'graphql',
    gql: 'graphql',
    proto: 'proto',
    zig: 'zig',
    ex: 'elixir',
    exs: 'elixir',
    erl: 'erlang',
    hs: 'haskell',
    clj: 'clojure',
    cljs: 'clojure',
    scala: 'scala',
    groovy: 'groovy',
    gradle: 'groovy',
    ps1: 'powershell',
    psml: 'powershell',
    r: 'r',
    jl: 'julia',
    pl: 'perl',
    pm: 'perl',
};

export function inferLanguageFromPath(filePath: string): string | undefined {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('dockerfile') || lower.endsWith('.dockerfile')) return 'dockerfile';
    if (lower.endsWith('makefile') || lower.endsWith('.mk')) return 'makefile';
    const dotIndex = lower.lastIndexOf('.');
    if (dotIndex <= 0 || dotIndex === lower.length - 1) return undefined;
    const ext = lower.slice(dotIndex + 1);
    if (ext.length > 10) return undefined;
    return EXTENSION_LANGUAGE_MAP[ext];
}

export function inferToolOutputLanguage(toolName: string | undefined, output: string): string | undefined {
    if (toolName === undefined) return undefined;
    for (const line of output.split('\n').slice(0, 8)) {
        const match = line.match(/([\w@./-]+\.[a-zA-Z]\w{0,9})\b/);
        if (match !== null && match[1] !== undefined) {
            const inferred = inferLanguageFromPath(match[1]);
            if (inferred !== undefined) return inferred;
        }
    }
    return undefined;
}

export function presentTranscriptPart(part: TranscriptPart): TranscriptPartPresentation {
    switch (part.type) {
        case 'user':
            return presentation(part, { title: 'User', lines: [part.text] });
        case 'assistant':
            return presentation(part, { title: part.title ?? 'Assistant', lines: [part.text], status: part.status });
        case 'reasoning':
            return presentation(part, { title: part.title ?? 'Thinking', lines: [part.text], status: part.status });
        case 'inline-tool':
            return presentation(part, {
                title: part.title ?? part.toolName ?? part.text,
                lines: detailLines({ text: part.text, detail: part.output ?? part.detail ?? part.error }),
                status: part.status,
            });
        case 'block-tool':
            return presentation(part, {
                title: part.title ?? part.toolName ?? part.text,
                lines: detailLines({ text: part.text, detail: part.output ?? part.detail ?? part.error }),
                status: part.status,
            });
        case 'diff':
            return presentation(part, {
                title: titleWithMetadata(part.title ?? 'Diff', part.filePath),
                lines: [part.text],
                status: part.status,
            });
        case 'code': {
            const language = safeCodeLanguage(part.language);
            return presentation(part, {
                title: titleWithMetadata(language === undefined ? 'Code' : `Code (${language})`, part.filePath),
                lines: part.text.split('\n'),
                status: part.status,
            });
        }
        case 'command':
            return presentation(part, {
                title: part.command ?? part.title ?? 'Command',
                lines: detailLines({
                    text: part.text,
                    detail: part.detail ?? part.error,
                    ...(part.exitCode === undefined ? {} : { extra: `Exit code: ${part.exitCode}` }),
                }),
                status: part.status,
            });
        case 'subagent':
            return presentation(part, {
                title: part.agentName ?? part.title ?? 'Subagent',
                lines: detailLines({
                    text: part.text,
                    detail: part.detail ?? part.error,
                    ...(part.sessionId === undefined ? {} : { extra: `Session: ${part.sessionId}` }),
                }),
                status: part.status,
            });
        case 'status':
            return presentation(part, {
                title: part.title ?? 'Status',
                lines: detailLines({ text: part.text, detail: part.detail }),
                status: part.status,
            });
        case 'event':
            return presentation(part, {
                title: part.title ?? part.eventType ?? 'Event',
                lines: detailLines({
                    text: part.text,
                    detail: part.detail,
                    ...(part.timestamp === undefined ? {} : { extra: part.timestamp }),
                }),
                status: part.status,
            });
        case 'error':
            return presentation(part, {
                title: part.code === undefined ? (part.title ?? 'Error') : `Error (${part.code})`,
                lines: detailLines({ text: part.text, detail: part.error ?? part.detail }),
                status: part.status,
            });
        case 'legacy':
            return presentation(part, { title: 'Legacy', lines: [part.text] });
        default:
            return assertNever(part);
    }
}

function presentation(part: TranscriptPart, content: PresentationContent): TranscriptPartPresentation {
    return {
        type: part.type,
        title: content.title,
        lines: content.lines,
        streaming: isTranscriptPartStreaming(content.status),
    };
}

function detailLines(input: DetailLinesInput): readonly string[] {
    const lines = input.text.split('\n');
    if (input.detail !== undefined && input.detail !== input.text) {
        lines.push(...input.detail.split('\n'));
    }
    if (input.extra !== undefined && input.extra !== input.text && input.extra !== input.detail) {
        lines.push(input.extra);
    }
    return lines;
}

function safeCodeLanguage(language: string | undefined): string | undefined {
    return language !== undefined && /^[a-zA-Z0-9][a-zA-Z0-9+_.-]*$/.test(language) ? language : undefined;
}

function longestBacktickRun(text: string): number {
    let longest = 0;
    let current = 0;
    for (const character of text) {
        if (character === '`') {
            current += 1;
            longest = Math.max(longest, current);
        } else {
            current = 0;
        }
    }
    return longest;
}

function titleWithMetadata(title: string, metadata: string | undefined): string {
    return metadata === undefined ? title : `${title}: ${metadata}`;
}

function assertNever(value: never): never {
    throw new Error(`Unexpected transcript part: ${JSON.stringify(value)}`);
}
