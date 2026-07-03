/**
 * Internal `://` scheme resolver middleware.
 *
 * Intercepts `repo.read` / `webfetch` / `file.write` inputs whose path or URL
 * carries a registered internal scheme (`pr`, `issue`, `agent`, `skill`,
 * `rule`, `conflict`) and resolves them through dedicated, injectable
 * backends instead of the filesystem / network / normal-write path.
 *
 * Ported from oh-my-pi `internal-urls` (MIT, Can Boeluek / Mario Zechner).
 * The reference is a process-global singleton with handlers that reach into
 * global registries; this port is dependency-injected and explicitly
 * NON-COLLAPSING:
 *   - `skill://` DELEGATES to the existing skill-loader via an injected
 *     `SkillSchemeBackend`. It never re-implements discovery.
 *   - `agent://` reads from an injected `AgentOutputStore` populated by the
 *     `task()` tool. It does not collapse with agent resolution.
 *   - `pr://` / `issue://` shell to `gh` through an injected
 *     `GithubSchemeBackend`, reusing the argv contract, not the tool gating.
 *   - `rule://` and `conflict://` have their own backends.
 *
 * No Bun APIs: file reads use `node:fs/promises`; process execution uses the
 * shared `executeCommand` executor (same one `command.run` uses).
 */
import type { InternalSchemeResource, InternalSchemeUrl } from '@mission-control/protocol';
import { isInternalSchemeInput, parseInternalSchemeUrl } from '@mission-control/protocol';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Resolve / write contexts
// ---------------------------------------------------------------------------

export interface SchemeResolveContext {
    readonly cwd?: string;
    readonly signal?: AbortSignal;
}

export interface SchemeWriteContext {
    readonly cwd?: string;
    readonly signal?: AbortSignal;
}

/**
 * One handler per scheme. `write` is optional: only `conflict://` is writable;
 * read-only schemes omit it and the write interceptor surfaces a clear error.
 */
export interface SchemeHandler {
    readonly scheme: string;
    readonly immutable: boolean;
    resolve(url: InternalSchemeUrl, context: SchemeResolveContext): Promise<InternalSchemeResource>;
    write?(url: InternalSchemeUrl, content: string, context: SchemeWriteContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Backends (injectable; parallel; non-collapsing)
// ---------------------------------------------------------------------------

/**
 * Runs `gh <args> --json <fields>` and returns the raw JSON stdout. The
 * resolver builds the argv (reusing the github-tool argv contract) and
 * renders markdown; the backend only executes. Default impl shells to `gh`
 * via the shared executor; tests inject a stub.
 */
export interface GithubSchemeBackend {
    runGhJson(args: readonly string[], context: SchemeResolveContext): Promise<string>;
}

/** A single task() output entry, populated by the task tool runtime. */
export interface AgentOutputEntry {
    readonly id: string;
    readonly content: string;
}

/**
 * Per-session store of `task()` outputs keyed by id. The `agent://` handler
 * reads from here. The default {@link InMemoryAgentOutputStore} is injected
 * by the wiring; the task tool registers outputs as they settle.
 */
export interface AgentOutputStore {
    listIds(): readonly string[];
    get(id: string): AgentOutputEntry | undefined;
    register(entry: AgentOutputEntry): void;
}

/** Discovered skill handle, mirroring the skill-loader `Skill` shape. */
export interface SkillSchemeEntry {
    readonly name: string;
    readonly filePath: string;
    readonly baseDir: string;
}

/**
 * Delegates `skill://` resolution to the EXISTING skill-loader. The default
 * wiring calls `discoverSkills({workspaceRoot})` and indexes by name; this
 * interface keeps the resolver decoupled from discovery internals and makes
 * delegation (not collapse) testable.
 */
export interface SkillSchemeBackend {
    resolveSkill(name: string): Promise<SkillSchemeEntry | undefined> | SkillSchemeEntry | undefined;
    listNames(): readonly string[];
}

/** Rule content entry (mission-control has no rule system yet; injectable). */
export interface RuleSchemeEntry {
    readonly name: string;
    readonly content: string;
}

export interface RuleSchemeBackend {
    resolveRule(name: string): Promise<RuleSchemeEntry | undefined> | RuleSchemeEntry | undefined;
    listNames(): readonly string[];
}

/** A single merge-conflict block inside a tracked file. */
export interface ConflictEntry {
    readonly number: number;
    readonly filePath: string;
    readonly ours: string;
    readonly theirs: string;
    /** Resolved base; empty when no merge-base content was recorded. */
    readonly base: string;
}

export type ConflictChoice = 'ours' | 'theirs' | 'base';

/**
 * Per-session merge-conflict history. `conflict://N` reads the Nth registered
 * block; `write conflict://N @theirs` resolves it in place. The default
 * {@link InMemoryConflictStore} parses conflict markers from file content.
 */
export interface ConflictStore {
    list(): readonly ConflictEntry[];
    get(number: number): ConflictEntry | undefined;
    register(entry: Omit<ConflictEntry, 'number'>): number;
    resolve(number: number, choice: ConflictChoice): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

export class InMemoryAgentOutputStore implements AgentOutputStore {
    private readonly entries = new Map<string, AgentOutputEntry>();

    listIds(): readonly string[] {
        return [...this.entries.keys()].sort();
    }

    get(id: string): AgentOutputEntry | undefined {
        return this.entries.get(id);
    }

    register(entry: AgentOutputEntry): void {
        this.entries.set(entry.id, entry);
    }
}

/**
 * Parses `<<<<<<<` / `=======` / `>>>>>>>` conflict markers and resolves a
 * chosen block by rewriting the host file. Numbering is per-store, stable
 * within a session, and 1-indexed so `conflict://1` is the first block.
 */
export class InMemoryConflictStore implements ConflictStore {
    private readonly entries: ConflictEntry[] = [];

    list(): readonly ConflictEntry[] {
        return [...this.entries];
    }

    get(number: number): ConflictEntry | undefined {
        return this.entries[number - 1];
    }

    register(entry: Omit<ConflictEntry, 'number'>): number {
        this.entries.push({ ...entry, number: this.entries.length + 1 });
        return this.entries.length;
    }

    async resolve(number: number, choice: ConflictChoice): Promise<void> {
        const entry = this.get(number);
        if (entry === undefined) {
            throw new Error(`conflict://${number} not found (registered: ${this.entries.length})`);
        }
        const original = await readFile(entry.filePath, 'utf8');
        const replaced = replaceConflictBlock(original, entry, choice);
        await writeFile(entry.filePath, replaced, 'utf8');
    }
}

// ---------------------------------------------------------------------------
// JSON path extraction (minimal jq-like, used by agent://)
// ---------------------------------------------------------------------------

/**
 * Extract a value from `data` by a dotted/bracket path such as
 * `findings.0.path` or `['special-key'].0`. Returns `undefined` when any
 * segment misses. Kept minimal and dependency-free.
 */
export function extractJsonPath(data: unknown, path: string): unknown {
    const segments = parsePathSegments(path);
    let current: unknown = data;
    for (const segment of segments) {
        if (current === null || current === undefined) {
            return undefined;
        }
        if (Array.isArray(current)) {
            const idx = typeof segment === 'number' ? segment : indexOfNumeric(segment);
            if (idx === null) {
                return undefined;
            }
            current = current[idx];
            continue;
        }
        if (typeof current !== 'object') {
            return undefined;
        }
        const record = current as Record<string, unknown>;
        current = record[segment];
    }
    return current;
}

function indexOfNumeric(segment: string): number | null {
    return /^\d+$/.test(segment) ? Number(segment) : null;
}

type PathSegment = string | number;

function parsePathSegments(path: string): readonly PathSegment[] {
    const trimmed = path.trim();
    if (trimmed.length === 0) {
        return [];
    }
    const clean = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
    if (clean.length === 0) {
        return [];
    }
    const segments: PathSegment[] = [];
    let i = 0;
    while (i < clean.length) {
        const ch = clean[i];
        if (ch === '.') {
            i += 1;
            continue;
        }
        if (ch === '[') {
            const close = clean.indexOf(']', i + 1);
            if (close === -1) {
                throw new Error(`Invalid JSON path (missing ]): ${path}`);
            }
            const raw = clean.slice(i + 1, close).trim();
            if (raw.length === 0) {
                throw new Error(`Invalid JSON path (empty []): ${path}`);
            }
            segments.push(decodeBracket(raw));
            i = close + 1;
            continue;
        }
        const start = i;
        while (i < clean.length && /[A-Za-z0-9_-]/.test(clean[i] ?? '')) {
            i += 1;
        }
        if (start === i) {
            throw new Error(`Invalid JSON path (unexpected '${clean[i] ?? ''}'): ${path}`);
        }
        segments.push(clean.slice(start, i));
    }
    return segments;
}

function decodeBracket(raw: string): PathSegment {
    const quote = raw[0];
    if ((quote === '"' || quote === "'") && raw.endsWith(quote)) {
        return raw.slice(1, -1).replace(/\\(["'\\])/g, '$1');
    }
    if (/^\d+$/.test(raw)) {
        return Number(raw);
    }
    return raw;
}

/**
 * Convert a URL pathname into a dotted extraction path. Both `/` and `.` act
 * as separators, so `/findings.0/path` and `/findings/0/path` both yield
 * `findings.0.path`. Pure numeric segments index arrays during extraction.
 */
export function pathnameToPath(pathname: string): string {
    if (pathname.length === 0 || pathname === '/') {
        return '';
    }
    const stripped = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    const rawSegments = stripped.split(/[/.]/).filter((s) => s.length > 0);
    if (rawSegments.length === 0) {
        return '';
    }
    const decoded: string[] = [];
    for (const segment of rawSegments) {
        try {
            decoded.push(decodeURIComponent(segment));
        } catch {
            decoded.push(segment);
        }
    }
    return decoded.join('.');
}

// ---------------------------------------------------------------------------
// Conflict marker parsing
// ---------------------------------------------------------------------------

const CONFLICT_OURS_RE = /^<{7}.*$/;
const CONFLICT_SEP_RE = /^={7}$/;
const CONFLICT_THEIRS_RE = /^>{7}.*$/;

interface ParsedConflictBlock {
    readonly startLine: number;
    readonly endLine: number;
    readonly ours: string;
    readonly theirs: string;
}

/**
 * Parse conflict marker blocks from `content`. Returns 1-indexed line ranges
 * (inclusive) plus the ours/theirs bodies. The base is not recoverable from
 * the working tree alone; callers that know it register it explicitly.
 */
export function parseConflictBlocks(content: string): readonly ParsedConflictBlock[] {
    const lines = content.split('\n');
    const blocks: ParsedConflictBlock[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line === undefined || !CONFLICT_OURS_RE.test(line)) {
            i += 1;
            continue;
        }
        const startLine = i;
        const oursLines: string[] = [];
        i += 1;
        while (i < lines.length) {
            const cur = lines[i];
            if (cur === undefined) {
                break;
            }
            if (CONFLICT_SEP_RE.test(cur)) {
                break;
            }
            if (CONFLICT_THEIRS_RE.test(cur)) {
                // Malformed (separator missing); treat rest as theirs.
                break;
            }
            oursLines.push(cur);
            i += 1;
        }
        const theirsLines: string[] = [];
        const sawSeparator = i < lines.length && lines[i] !== undefined && CONFLICT_SEP_RE.test(lines[i] ?? '');
        if (sawSeparator) {
            i += 1;
        }
        while (i < lines.length) {
            const cur = lines[i];
            if (cur === undefined) {
                break;
            }
            if (CONFLICT_THEIRS_RE.test(cur)) {
                break;
            }
            theirsLines.push(cur);
            i += 1;
        }
        if (i < lines.length && lines[i] !== undefined && CONFLICT_THEIRS_RE.test(lines[i] ?? '')) {
            i += 1;
        }
        blocks.push({
            startLine,
            endLine: i - 1,
            ours: oursLines.join('\n'),
            theirs: theirsLines.join('\n'),
        });
    }
    return blocks;
}

function replaceConflictBlock(content: string, entry: ConflictEntry, choice: ConflictChoice): string {
    const lines = content.split('\n');
    const blocks = parseConflictBlocks(content);
    const index = entry.number - 1;
    const block = blocks[index];
    if (block === undefined) {
        throw new Error(`conflict://${entry.number} no longer present in ${entry.filePath}`);
    }
    const replacement = choice === 'ours' ? entry.ours : choice === 'theirs' ? entry.theirs : entry.base;
    const replacementLines = replacement.length > 0 ? replacement.split('\n') : [];
    const next = [...lines.slice(0, block.startLine), ...replacementLines, ...lines.slice(block.endLine + 1)];
    return next.join('\n');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const PR_VIEW_FIELDS =
    'number,title,state,isDraft,author,baseRefName,headRefName,body,url,labels,createdAt,updatedAt,mergeStateStatus,reviewDecision';
const PR_VIEW_FIELDS_WITH_COMMENTS = `${PR_VIEW_FIELDS},reviews,comments`;
const ISSUE_VIEW_FIELDS = 'number,title,state,stateReason,author,body,url,labels,createdAt,updatedAt';
const ISSUE_VIEW_FIELDS_WITH_COMMENTS = `${ISSUE_VIEW_FIELDS},comments`;

interface PrIssueRef {
    readonly repo?: string;
    readonly number: number;
    readonly comments: boolean;
}

function parsePrIssueUrl(url: InternalSchemeUrl, scheme: 'pr' | 'issue'): PrIssueRef {
    const host = url.rawHost;
    const rawPath = url.pathname;
    const stripped = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
    const parts = stripped.length === 0 ? [] : stripped.split('/').filter((s) => s.length > 0);
    if (host.length === 0 && parts.length === 0) {
        throw new Error(`${scheme}:// requires a number or owner/repo/number`);
    }
    // scheme://N
    if (host.length > 0 && parts.length === 0) {
        return { number: requireNumber(scheme, host), comments: commentsParam(url) };
    }
    // scheme://owner/repo/N
    if (host.length > 0 && parts.length >= 2) {
        return {
            repo: `${host}/${parts[0]}`,
            number: requireNumber(scheme, parts[1] ?? ''),
            comments: commentsParam(url),
        };
    }
    // scheme://owner/repo → listing, not supported as a single read target.
    if (host.length > 0 && parts.length === 1) {
        throw new Error(
            `${scheme}://${host}/${parts[0]} is a listing; read a specific item as ${scheme}://${host}/${parts[0]}/<N>`,
        );
    }
    throw new Error(`Invalid ${scheme}:// URL. Use ${scheme}://<N> or ${scheme}://<owner>/<repo>/<N>.`);
}

function commentsParam(url: InternalSchemeUrl): boolean {
    const raw = url.searchParams.get('comments');
    if (raw === null) {
        return true;
    }
    return !(raw === '0' || raw.toLowerCase() === 'false');
}

function requireNumber(scheme: string, value: string): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid ${scheme}:// number: ${value.length === 0 ? '(missing)' : value}`);
    }
    return Number(value);
}

function renderPrOrIssue(scheme: 'pr' | 'issue', url: InternalSchemeUrl, json: string): InternalSchemeResource {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(json) as Record<string, unknown>;
    } catch {
        return resource(url, json, 'text/plain', [`github returned non-JSON for ${scheme}://`]);
    }
    const number = parsed['number'];
    const title = parsed['title'];
    const state = parsed['state'];
    const author = authorLogin(parsed['author']);
    const body = typeof parsed['body'] === 'string' ? parsed['body'] : '';
    const itemUrl = parsed['url'];
    const head = `# ${scheme.toUpperCase()} #${number ?? '?'}: ${title ?? '(no title)'}\n\n- state: ${state ?? '?'}${author !== null ? `\n- author: @${author}` : ''}${typeof itemUrl === 'string' ? `\n- url: ${itemUrl}` : ''}\n`;
    const notes: string[] = [`Resolved via github (${scheme}_view)`];
    return resource(url, `${head}\n${body}\n`, 'text/markdown', notes);
}

function authorLogin(author: unknown): string | null {
    if (author === null || typeof author !== 'object') {
        return null;
    }
    const login = (author as Record<string, unknown>)['login'];
    return typeof login === 'string' ? login : null;
}

class PrIssueHandler implements SchemeHandler {
    readonly immutable = true;
    constructor(
        readonly scheme: 'pr' | 'issue',
        private readonly backend: GithubSchemeBackend,
    ) {}

    async resolve(url: InternalSchemeUrl, context: SchemeResolveContext): Promise<InternalSchemeResource> {
        const ref = parsePrIssueUrl(url, this.scheme);
        const args: string[] =
            this.scheme === 'pr' ? ['pr', 'view', String(ref.number)] : ['issue', 'view', String(ref.number)];
        if (ref.repo !== undefined) {
            args.push('--repo', ref.repo);
        }
        args.push('--json', ref.comments ? PR_VIEW_FIELDS_WITH_COMMENTS : PR_VIEW_FIELDS);
        const json = await this.backend.runGhJson(args, context);
        return renderPrOrIssue(this.scheme, url, json);
    }
}

class AgentHandler implements SchemeHandler {
    readonly scheme = 'agent';
    readonly immutable = true;
    constructor(private readonly store: AgentOutputStore) {}

    async resolve(url: InternalSchemeUrl): Promise<InternalSchemeResource> {
        const id = url.rawHost;
        if (id.length === 0) {
            throw new Error(`agent:// requires an output id: agent://<id>`);
        }
        const entry = this.store.get(id);
        if (entry === undefined) {
            throw new Error(`agent://${id} not found. Available: ${formatList(this.store.listIds())}`);
        }
        const pathQuery = url.searchParams.get('q');
        const hasPath = url.pathname.length > 0 && url.pathname !== '/';
        const hasQuery = pathQuery !== null && pathQuery.length > 0;
        if (hasPath && hasQuery) {
            throw new Error(`agent:// cannot combine path extraction with ?q=`);
        }
        let content = entry.content;
        let contentType: 'text/markdown' | 'application/json' | 'text/plain' = 'text/markdown';
        const notes: string[] = [];
        if (hasPath || hasQuery) {
            const path = hasPath ? pathnameToPath(url.pathname) : (pathQuery ?? '');
            let jsonValue: unknown;
            try {
                jsonValue = JSON.parse(entry.content);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`agent://${id} is not valid JSON for path extraction: ${message}`);
            }
            const extracted = path.length > 0 ? extractJsonPath(jsonValue, path) : jsonValue;
            content = safeStringify(extracted);
            contentType = 'application/json';
            notes.push(`Extracted: ${path}`);
        }
        return resource(url, content, contentType, notes);
    }
}

class SkillHandler implements SchemeHandler {
    readonly scheme = 'skill';
    readonly immutable = true;
    constructor(private readonly backend: SkillSchemeBackend) {}

    async resolve(url: InternalSchemeUrl): Promise<InternalSchemeResource> {
        const name = url.rawHost;
        if (name.length === 0) {
            throw new Error(`skill:// requires a skill name: skill://<name>`);
        }
        const skill = await this.backend.resolveSkill(name);
        if (skill === undefined) {
            throw new Error(`skill://${name} not found. Available: ${formatList(this.backend.listNames())}`);
        }
        const relativePath =
            url.pathname.length > 0 && url.pathname !== '/' ? decodeURIComponent(url.pathname.slice(1)) : '';
        let targetPath = skill.filePath;
        const notes: string[] = [];
        if (relativePath.length > 0) {
            validateRelativePath(relativePath);
            const candidate = join(skill.baseDir, relativePath);
            const resolvedCandidate = resolve(candidate);
            const resolvedBase = resolve(skill.baseDir);
            if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(resolvedBase + sep)) {
                throw new Error(`skill:// path escapes the skill directory`);
            }
            targetPath = candidate;
            notes.push(`Relative read: ${relativePath}`);
        }
        const content = await readFile(targetPath, 'utf8');
        const contentType = targetPath.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain';
        return resource(url, content, contentType, notes);
    }
}

class RuleHandler implements SchemeHandler {
    readonly scheme = 'rule';
    readonly immutable = true;
    constructor(private readonly backend: RuleSchemeBackend) {}

    async resolve(url: InternalSchemeUrl): Promise<InternalSchemeResource> {
        const name = url.rawHost;
        if (name.length === 0) {
            throw new Error(`rule:// requires a rule name: rule://<name>`);
        }
        const rule = await this.backend.resolveRule(name);
        if (rule === undefined) {
            throw new Error(`rule://${name} not found. Available: ${formatList(this.backend.listNames())}`);
        }
        return resource(url, rule.content, 'text/markdown', []);
    }
}

class ConflictHandler implements SchemeHandler {
    readonly scheme = 'conflict';
    readonly immutable = false;
    constructor(private readonly store: ConflictStore) {}

    async resolve(url: InternalSchemeUrl): Promise<InternalSchemeResource> {
        const host = url.rawHost;
        if (host === '*') {
            const entries = this.store.list();
            const body =
                entries.length === 0
                    ? '_No registered conflicts._'
                    : entries
                          .map(
                              (e) =>
                                  `- conflict://${e.number}  ${e.filePath}  (ours ${byteLabel(e.ours)} · theirs ${byteLabel(e.theirs)})`,
                          )
                          .join('\n');
            return resource(url, `# Conflicts (${entries.length})\n\n${body}\n`, 'text/markdown', []);
        }
        const number = requireNumber('conflict', host);
        const entry = this.store.get(number);
        if (entry === undefined) {
            throw new Error(`conflict://${number} not found. Read conflict://* to list.`);
        }
        const content = `# Conflict ${number}: ${entry.filePath}\n\n## ours\n\n${entry.ours}\n\n## theirs\n\n${entry.theirs}\n${entry.base.length > 0 ? `\n## base\n\n${entry.base}\n` : ''}`;
        const notes = [`Resolve with: write conflict://${number} @ours|@theirs|@base`, `File: ${entry.filePath}`];
        return resource(url, content, 'text/markdown', notes);
    }

    async write(url: InternalSchemeUrl, content: string, _context: SchemeWriteContext): Promise<void> {
        const host = url.rawHost;
        if (host === '*') {
            const entries = this.store.list();
            const choice = parseConflictChoice(content);
            for (const entry of entries) {
                await this.store.resolve(entry.number, choice);
            }
            return;
        }
        const number = requireNumber('conflict', host);
        await this.store.resolve(number, parseConflictChoice(content));
    }
}

function parseConflictChoice(content: string): ConflictChoice {
    const trimmed = content.trim();
    if (trimmed === '@ours' || trimmed === '@theirs' || trimmed === '@base') {
        return trimmed.slice(1) as ConflictChoice;
    }
    throw new Error(`conflict:// write content must be @ours, @theirs, or @base (got: ${content.trim()})`);
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export class SchemeResolver {
    private readonly handlers = new Map<string, SchemeHandler>();

    register(handler: SchemeHandler): void {
        this.handlers.set(handler.scheme.toLowerCase(), handler);
    }

    unregister(scheme: string): boolean {
        return this.handlers.delete(scheme.toLowerCase());
    }

    getHandler(scheme: string): SchemeHandler | undefined {
        return this.handlers.get(scheme.toLowerCase());
    }

    /** Does `input` carry a scheme this resolver can handle? */
    matches(input: string): boolean {
        if (!isInternalSchemeInput(input)) {
            return false;
        }
        const parsed = parseInternalSchemeUrl(input);
        return this.handlers.has(parsed.scheme);
    }

    listSchemes(): readonly string[] {
        return [...this.handlers.keys()].sort();
    }

    async resolve(input: string, context: SchemeResolveContext = {}): Promise<InternalSchemeResource> {
        const url = parseInternalSchemeUrl(input);
        const handler = this.handlers.get(url.scheme);
        if (handler === undefined) {
            throw new Error(`Unknown scheme: ${url.scheme}://\nRegistered: ${formatList(this.listSchemes())}`);
        }
        const resource = await handler.resolve(url, context);
        return { ...resource, immutable: resource.immutable ?? handler.immutable };
    }

    async write(input: string, content: string, context: SchemeWriteContext = {}): Promise<void> {
        const url = parseInternalSchemeUrl(input);
        const handler = this.handlers.get(url.scheme);
        if (handler === undefined) {
            throw new Error(`Unknown scheme: ${url.scheme}://\nRegistered: ${formatList(this.listSchemes())}`);
        }
        if (handler.write === undefined) {
            throw new Error(`${url.scheme}:// is read-only`);
        }
        await handler.write(url, content, context);
    }
}

/**
 * Build a resolver from injectable backends. Absent backends simply omit
 * their scheme, so `read pr://...` with no github backend surfaces a clear
 * "unknown scheme" error instead of a silent fallthrough.
 */
export function createSchemeResolver(backends: {
    readonly github?: GithubSchemeBackend;
    readonly agentOutputs?: AgentOutputStore;
    readonly skills?: SkillSchemeBackend;
    readonly rules?: RuleSchemeBackend;
    readonly conflicts?: ConflictStore;
}): SchemeResolver {
    const resolver = new SchemeResolver();
    if (backends.github !== undefined) {
        resolver.register(new PrIssueHandler('pr', backends.github));
        resolver.register(new PrIssueHandler('issue', backends.github));
    }
    if (backends.agentOutputs !== undefined) {
        resolver.register(new AgentHandler(backends.agentOutputs));
    }
    if (backends.skills !== undefined) {
        resolver.register(new SkillHandler(backends.skills));
    }
    if (backends.rules !== undefined) {
        resolver.register(new RuleHandler(backends.rules));
    }
    if (backends.conflicts !== undefined) {
        resolver.register(new ConflictHandler(backends.conflicts));
    }
    return resolver;
}

// ---------------------------------------------------------------------------
// Interceptor helpers (used by read-tools / webfetch / file-write)
// ---------------------------------------------------------------------------

/**
 * Read-tool interceptor result. `undefined` means "no scheme matched; fall
 * through to the filesystem path". A present value short-circuits the read.
 */
export interface InterceptedRead {
    readonly content: string;
    readonly sourceLabel: string;
    readonly notes: readonly string[];
}

export async function interceptRead(
    resolver: SchemeResolver,
    path: string,
    context: SchemeResolveContext = {},
): Promise<InterceptedRead | undefined> {
    if (!resolver.matches(path)) {
        return undefined;
    }
    const resource = await resolver.resolve(path, context);
    return {
        content: resource.content,
        sourceLabel: resource.url,
        notes: resource.notes ?? [],
    };
}

/**
 * webfetch interceptor. Returns resolved body when the URL carries a
 * registered scheme; `undefined` to proceed with a normal network fetch.
 */
export async function interceptWebfetch(
    resolver: SchemeResolver,
    url: string,
    context: SchemeResolveContext = {},
): Promise<InterceptedRead | undefined> {
    return interceptRead(resolver, url, context);
}

/**
 * file.write interceptor. Returns `true` when the path was a writable scheme
 * (conflict://) and the resolver handled it; `false` to proceed with a
 * normal file write.
 */
export async function interceptWrite(
    resolver: SchemeResolver,
    path: string,
    content: string,
    context: SchemeWriteContext = {},
): Promise<boolean> {
    if (!resolver.matches(path)) {
        return false;
    }
    await resolver.write(path, content, context);
    return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resource(
    url: InternalSchemeUrl,
    content: string,
    contentType: 'text/markdown' | 'application/json' | 'text/plain',
    notes: readonly string[],
): InternalSchemeResource {
    const base: InternalSchemeResource = {
        url: url.href,
        content,
        contentType,
        size: Buffer.byteLength(content, 'utf8'),
    };
    if (notes.length > 0) {
        return { ...base, notes: [...notes] };
    }
    return base;
}

function formatList(values: readonly string[]): string {
    return values.length > 0 ? values.join(', ') : 'none';
}

function byteLabel(text: string): string {
    return `${Buffer.byteLength(text, 'utf8')}B`;
}

function safeStringify(value: unknown): string {
    try {
        const text = JSON.stringify(value, null, 2);
        return text === undefined ? 'null' : text;
    } catch {
        return String(value);
    }
}

function validateRelativePath(relativePath: string): void {
    if (isAbsolute(relativePath)) {
        throw new Error('Absolute paths are not allowed in skill:// URLs');
    }
    const normalized = normalize(relativePath);
    if (normalized.startsWith('..') || normalized.includes(`${sep}..${sep}`) || normalized.includes(`..${sep}`)) {
        throw new Error('Path traversal (..) is not allowed in skill:// URLs');
    }
}
