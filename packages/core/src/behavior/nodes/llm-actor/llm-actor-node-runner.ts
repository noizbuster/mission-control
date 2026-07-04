/**
 * LLMActor as an ABG node runner (`AbgNodeRunner`).
 *
 * This is the bridge between the graph and the Phase-0 Vercel-AI-SDK keystone. The node:
 *   1. reads the running conversation from the Blackboard (`getMessages`);
 *   2. builds the AI-SDK tool set from the ToolRegistry via `abg-tool-bridge` (so every
 *      tool crosses the §5.2 policy-await seam — the SDK owns dispatch, ABG wraps it);
 *   3. runs exactly ONE `streamText` step — `runLlmActor` pins `stopWhen: stepCountIs(1)`,
 *      so each node run = one model call + one tool batch (the SDK never loops on its own);
 *   4. appends the SDK's response messages (assistant turn + executed tool results) back
 *      onto the Blackboard, and sets `llm.loop_active`.
 *
 * The graph re-enters this node for the next step via a rule-gated self-edge on
 * `blackboard.value.equals { key:'llm.loop_active', value:true }`. So the GRAPH owns the
 * loop — every tool turn is a graph transition — never the SDK (ABG §10.3).
 *
 * Resolves the "runLlmActor not yet AbgNodeRunner-shaped" part of deferred review #10:
 * the LLMActor is now graph-driven with an observable signal stream; the authoritative
 * 3-state per-action policy decision lives at node altitude in `PolicyGateNode`,
 * complementing the bridge's synchronous SDK-contract gate.
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { ConversationSummary } from '../../../context/compaction.js';
import { packContext } from '../../../context/context-packer.js';
import { assembleSystemPrompt, type SystemPromptSkill } from '../../../context/system-prompt.js';
import type { Blackboard } from '../../../memory/blackboard.js';
import { discoverSkills, resolveUserConfigDir } from '../../../skills/skill-loader.js';
import { defaultReadOnlyRepoToolDenylist, toPosixPath } from '../../../tools/read-tools-paths.js';
import type { ToolAdvertisement } from '../../../tools/tool-registry-types.js';
import { createAbgEmitSignal } from '../../abg-emit.js';
import type { AbgNodeRunContext, AbgNodeRunner } from '../../node-registry.js';
import {
    type ParseStructuredOutputResult,
    parseStructuredOutput,
    type StructuredOutputShape,
} from '../../structured-blackboard.js';
import { bridgeAdvertisementsToAiSdk, createAbgToolSettlementLedger } from './abg-tool-bridge.js';
import { type LlmActorTurnResult, runLlmActor } from './llm-actor-node.js';
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Skill discovery session cache (todo 13). Keyed on the per-run Blackboard (WeakMap → GC-safe,
// no cross-session leak). Invalidation is a recursive per-file mtime+size manifest, NOT root-only
// dir mtime (which misses file edits + deep adds — Metis F2). SIZE_OK: plan mandates this lives
// module-level here; extraction to a sibling is forbidden.

type SkillManifest = Map<string, readonly [mtimeMs: number, size: number]>;
type SkillCacheEntry = { readonly skills: readonly SystemPromptSkill[]; readonly manifest: SkillManifest };

const MAX_MANIFEST_WALK_DEPTH = 10;

let skillCache = new WeakMap<Blackboard, SkillCacheEntry>();

/** @internal Test-only: drops every cached entry so spy call-counts are isolated per test. */
export function _testResetSkillCache(): void {
    skillCache = new WeakMap();
}

/**
 * Drops every cached skill-discovery entry so the next `runLlmActorNode` turn re-runs
 * `discoverSkills` regardless of the file manifest. Called by the `/skills reload` and
 * `/agents reload` chat actions so an explicit reload always serves fresh skills.
 */
export function bustSkillCache(): void {
    skillCache = new WeakMap();
}

const manifestDenylistNeedles: readonly string[] = defaultReadOnlyRepoToolDenylist.map((entry) => entry.toLowerCase());
const manifestDenylistDirNames: ReadonlySet<string> = new Set(
    defaultReadOnlyRepoToolDenylist.filter((entry) => !entry.includes('/')).map((entry) => entry.toLowerCase()),
);

function pathMatchesDenylist(absolutePath: string): boolean {
    const posix = toPosixPath(absolutePath).toLowerCase();
    return manifestDenylistNeedles.some((needle) =>
        needle.length === 0 ? false : posix === needle || posix.includes(`/${needle}/`) || posix.endsWith(`/${needle}`),
    );
}

/** MUST mirror `discoverSkills` scope resolution (global-user, project-mctrl, project-agents). */
function resolveSkillScopeRoots(workspaceRoot: string): readonly string[] {
    const roots: string[] = [join(resolveUserConfigDir({}), 'skills')];
    if (!pathMatchesDenylist(workspaceRoot)) {
        roots.push(join(workspaceRoot, '.mctrl', 'skills'));
        roots.push(join(workspaceRoot, '.agents', 'skills'));
    }
    return roots;
}

/** MUST mirror `walkSkillFiles`: depth-bounded, symlink-safe, denylist-pruned. Stat-only (no read/parse). */
async function walkSkillManifestFiles(scopeRoot: string): Promise<readonly string[]> {
    const results: string[] = [];
    const queue: Array<{ readonly dir: string; readonly depth: number }> = [{ dir: scopeRoot, depth: 0 }];
    while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined || item.depth > MAX_MANIFEST_WALK_DEPTH) continue;
        let entries: readonly Dirent[];
        try {
            entries = await readdir(item.dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const fullPath = join(item.dir, entry.name);
            if (entry.isDirectory()) {
                if (manifestDenylistDirNames.has(entry.name.toLowerCase())) continue;
                queue.push({ dir: fullPath, depth: item.depth + 1 });
                continue;
            }
            if (entry.isFile() && entry.name === 'SKILL.md') {
                results.push(fullPath);
            }
        }
    }
    return results.sort();
}

async function buildSkillManifest(workspaceRoot: string): Promise<SkillManifest> {
    const manifest: SkillManifest = new Map();
    for (const scopeRoot of resolveSkillScopeRoots(workspaceRoot)) {
        for (const filePath of await walkSkillManifestFiles(scopeRoot)) {
            try {
                const stats = await stat(filePath);
                manifest.set(filePath, [stats.mtimeMs, stats.size] as const);
            } catch {
                // File vanished between walk and stat — discovery will skip it too.
            }
        }
    }
    return manifest;
}

function manifestsEqual(a: SkillManifest, b: SkillManifest): boolean {
    if (a.size !== b.size) return false;
    for (const [path, [mtimeMs, size]] of a) {
        const entry = b.get(path);
        if (entry === undefined) return false;
        if (entry[0] !== mtimeMs || entry[1] !== size) return false;
    }
    return true;
}

export async function* runLlmActorNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    const nodeId = node.id;
    const graphIdPart = { graphId: context.graphId };

    if (context.sdkModel === undefined) {
        yield { type: 'started', nodeId, ...graphIdPart };
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: { code: 'llm_model_unavailable', message: 'no SDK model resolved for the LLMActor node' },
        };
        return;
    }
    const blackboard = context.blackboard;
    if (blackboard === undefined) {
        yield { type: 'started', nodeId, ...graphIdPart };
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: { code: 'memory_unavailable', message: 'LLMActor requires a blackboard for the conversation' },
        };
        return;
    }
    const messages = blackboard.getMessages();
    if (messages.length === 0) {
        yield { type: 'started', nodeId, ...graphIdPart };
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: { code: 'llm_no_input', message: 'the blackboard has no messages to send to the model' },
        };
        return;
    }

    const hasOutputKey = readStringConfig(node, 'outputKey') !== undefined;
    const hasCapabilities = (node.capabilities ?? []).length > 0;
    const capabilitiesExplicitlyEmpty = Array.isArray(node.capabilities) && node.capabilities.length === 0;
    const suppressTools = capabilitiesExplicitlyEmpty || (hasOutputKey && !hasCapabilities);
    const allAdvertisements = suppressTools
        ? []
        : context.toolRegistry !== undefined
          ? context.toolRegistry.advertise()
          : [];
    const advertisements = filterByCapabilities(allAdvertisements, node.capabilities);
    const toolSnippets = advertisements.map((advertisement) => ({
        name: advertisement.name,
        description: advertisement.description,
    }));
    const guidelines = advertisements
        .map((advertisement) => advertisement.guideline)
        .filter((guideline): guideline is string => typeof guideline === 'string' && guideline.length > 0);
    // Discover skills once per graph run (cached on the per-run Blackboard), invalidated by a
    // recursive per-file mtime+size manifest so newly added or edited SKILL.md files are picked
    // up without a restart. Only name + description + location go into the prompt (NOT bodies —
    // bodies load on demand via the `skill` tool). Skills with disableModelInvocation are hidden.
    const workspaceRoot = context.systemPromptEnv?.workspaceRoot;
    const skills: readonly SystemPromptSkill[] =
        workspaceRoot !== undefined ? await discoverPromptSkills(workspaceRoot, blackboard) : [];
    // The system prompt is assembled with the caller-supplied environment + trusted project
    // instructions. Without `env` the model has no workspace awareness (cwd, git, date); without
    // `resources` it never sees AGENTS.md/CLAUDE.md — both gaps make the agent answer generically
    // instead of acting on the codebase. An explicit node `systemPrompt` config still wins.
    const system =
        readStringConfig(node, 'systemPrompt') ??
        assembleSystemPrompt({
            toolSnippets,
            guidelines,
            skills,
            ...(context.systemPromptEnv !== undefined ? { env: context.systemPromptEnv } : {}),
            ...(context.projectInstructionResources !== undefined
                ? { resources: context.projectInstructionResources }
                : {}),
        });
    // One ledger per turn: the bridge records each tool settlement; the stream-part adapter
    // reads it so the `tool.completed`/`tool.failed` emits carry the true status/output/error
    // (coding-step replay parity with the flat path). Fresh per turn — no stale entries leak.
    const settlementLedger = createAbgToolSettlementLedger();
    const tools =
        suppressTools || context.toolRegistry === undefined
            ? undefined
            : bridgeAdvertisementsToAiSdk(context.toolRegistry, advertisements, {
                  settlementLedger,
                  // Forward the tool's own events (file.diff.applied, ...) into the graph stream so
                  // the graph surfaces the same rich tool events the flat loop's settleToolCalls does.
                  ...(context.emitEvent !== undefined ? { onToolEvent: context.emitEvent } : {}),
                  // Interactive path: serialize a tool BATCH so the approval broker sees one approval
                  // at a time (non-interactive omits this → parallel batch execution).
                  ...(context.serializeToolExecution === true ? { serializeToolExecution: true } : {}),
              });

    // Keep the model's input BOUNDED across a long run: compact the older conversation into a
    // structured summary when it exceeds the budget, preserving the recent tail verbatim. The
    // full history stays on the Blackboard (the ledger); only the model-facing view is packed.
    const priorSummary = readPriorSummary(blackboard);
    const packed = packContext({
        messages,
        ...(priorSummary !== undefined ? { priorSummary } : {}),
    });
    if (packed.compacted && packed.summary !== undefined) {
        blackboard.set('context.summary', packed.summary);
        yield createAbgEmitSignal({
            graphId: context.graphId,
            nodeId,
            source: 'llm-actor',
            eventType: 'context.packed',
            timestamp: context.now(),
            payload: {
                estimatedTokens: packed.estimatedTokens,
                cutPointIndex: packed.cutPointIndex,
                summarizedMessageCount: packed.summary.summarizedMessageCount,
            },
        });
    }

    let turnResult: LlmActorTurnResult | undefined;
    let proposedToolCalls = 0;
    for await (const signal of runLlmActor({
        graphId: context.graphId,
        nodeId,
        model: context.sdkModel,
        system,
        messages: [...packed.messages],
        ...(tools !== undefined ? { tools } : {}),
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
        now: context.now,
        ...(context.toolRegistry !== undefined ? { settlementLedger } : {}),
        ...(context.haltOnFailedToolSettlement === true ? { haltOnFailedToolSettlement: true } : {}),
    })) {
        if (signal.type === 'emit' && signal.event.type === 'llm.tool_call.proposed') {
            proposedToolCalls += 1;
        }
        if (signal.type === 'success') {
            turnResult = extractTurnResult(signal.result);
        }
        yield signal;
    }

    // loop_active is ALWAYS written so a failed/aborted turn after a tool step CLEARS it
    // (otherwise the rule-gated self-edge would spin re-entering until maxNodeRuns). It is
    // derived from THIS turn's tool-call proposals — what the model decided this step — not
    // from response.messages roles, so it is robust to how the SDK shapes response.messages.
    let loopActive = turnResult !== undefined && proposedToolCalls > 0;
    blackboard.set('llm.loop_active', loopActive);
    if (turnResult !== undefined) {
        blackboard.appendMessages(turnResult.responseMessages);
        const outputKey = readStringConfig(node, 'outputKey');
        if (outputKey !== undefined) {
            const parsed: ParseStructuredOutputResult =
                turnResult.text.trim().length > 0
                    ? parseStructuredOutput(turnResult.text, readOutputShape(node))
                    : { ok: true, value: true };
            const outputResult = applyShapeDefaultFallback(
                node,
                applyEnumConstraint(node, parsed),
                readOutputShape(node),
            );
            if (outputResult.ok) {
                blackboard.set(outputKey, outputResult.value);
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId,
                    source: 'llm-actor',
                    eventType: 'blackboard.set',
                    timestamp: context.now(),
                    payload: { key: outputKey, value: outputResult.value },
                });
                // If the model produced valid structured output ALONGSIDE tool calls, clear
                // loopActive so the graph advances past this node instead of spinning on the
                // self-edge. Previously the outputKey was only persisted when loopActive was
                // already false, so a model that called tools AND emitted its classification
                // in one turn would loop forever (bounded only by maxNodeRuns).
                if (loopActive) {
                    loopActive = false;
                    blackboard.set('llm.loop_active', false);
                }
            } else if (!loopActive) {
                // FAIL CLOSED: invalid structured output for a declared outputKey on a turn
                // that did NOT request another tool loop. Do not persist a partial/garbage
                // value; surface a node failure so the graph can route to a fallback.
                // When loopActive is true, leave the loop running so the model gets another
                // chance to produce valid output on the next re-entry (the loop-active cap
                // from the coordinator still bounds the total number of retries).
                yield {
                    type: 'failure',
                    nodeId,
                    ...graphIdPart,
                    error: {
                        code: 'invalid_structured_output',
                        message: `invalid structured output for outputKey ${outputKey}: ${outputResult.error}`,
                    },
                };
                return;
            }
        }
        // Price this turn's usage and surface `policy.budget.*` events when a ledger is wired
        // (ABG §11.4). The graph can route `policy.budget.exceeded` to an escalate/abort node.
        if (context.budgetLedger !== undefined && context.model !== undefined) {
            for (const event of context.budgetLedger.accumulate({
                usage: turnResult.usage,
                selection: context.model,
            })) {
                const { eventType, cents, inputTokens, outputTokens, modelCalls, ...rest } = event;
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId,
                    source: 'llm-actor',
                    eventType,
                    timestamp: context.now(),
                    payload: {
                        cents,
                        inputTokens,
                        outputTokens,
                        modelCalls,
                        ...rest,
                    },
                });
            }
        }
    }
}

function readStringConfig(node: AbgNodeSpec, key: string): string | undefined {
    const value = node.config?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Filter tool advertisements by the node's declared capabilities.
 *
 * - `undefined` capabilities → all tools (backward compat: undeclared = inherit).
 * - `[]` capabilities → no tools (handled earlier by `capabilitiesExplicitlyEmpty`).
 * - Non-empty capabilities → only tools whose `capabilityClasses` intersect.
 */
function filterByCapabilities(
    advertisements: readonly ToolAdvertisement[],
    capabilities: readonly string[] | undefined,
): readonly ToolAdvertisement[] {
    if (capabilities === undefined) {
        return advertisements;
    }
    if (capabilities.length === 0) {
        return [];
    }
    const capabilitySet = new Set(capabilities);
    return advertisements.filter((ad) => ad.capabilityClasses.some((cls) => capabilitySet.has(cls)));
}

function readOutputShape(node: AbgNodeSpec): StructuredOutputShape {
    const value = readStringConfig(node, 'outputShape');
    if (value === 'object' || value === 'array' || value === 'boolean' || value === 'string' || value === 'any') {
        return value;
    }
    return 'any';
}

function readOutputEnum(node: AbgNodeSpec): readonly string[] | undefined {
    const value = node.config?.['outputEnum'];
    if (!Array.isArray(value)) {
        return undefined;
    }
    const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return entries.length > 0 ? entries : undefined;
}

function readOutputDefault(node: AbgNodeSpec): string | undefined {
    return readStringConfig(node, 'outputDefault');
}

// Substitutes outputDefault (when in-enum) for an out-of-enum value so a
// classifier node degrades to a routable branch instead of silently stalling.
function applyEnumConstraint(node: AbgNodeSpec, parsed: ParseStructuredOutputResult): ParseStructuredOutputResult {
    if (!parsed.ok) {
        return parsed;
    }
    const outputEnum = readOutputEnum(node);
    if (outputEnum === undefined) {
        return parsed;
    }
    if (typeof parsed.value === 'string' && outputEnum.includes(parsed.value)) {
        return parsed;
    }
    const fallback = readOutputDefault(node);
    if (fallback !== undefined && outputEnum.includes(fallback)) {
        return { ok: true, value: fallback };
    }
    return {
        ok: false,
        error: `output for outputKey not in declared outputEnum ${JSON.stringify(outputEnum)}: ${JSON.stringify(parsed.value)}`,
    };
}

/**
 * Graceful degradation: when structured-output parsing failed (and no enum
 * constraint rescued it), fall back to a safe value so a single misbehaving
 * LLM turn cannot kill the entire graph run.
 *
 * Resolution order:
 *   1. explicit `outputDefault` coerced to the expected shape
 *   2. shape-specific safe default: `array` → `[]`, `boolean` → `false`
 *   3. original `{ ok: false, error }` (fail-closed) for shapes without an
 *      unambiguous safe default (`object`, `string`, `any`)
 */
function applyShapeDefaultFallback(
    node: AbgNodeSpec,
    parsed: ParseStructuredOutputResult,
    shape: StructuredOutputShape,
): ParseStructuredOutputResult {
    if (parsed.ok) {
        return parsed;
    }
    if (readOutputEnum(node) !== undefined) {
        return parsed;
    }
    const fallback = readOutputDefault(node);
    if (fallback !== undefined) {
        const coerced = coerceDefaultToShape(fallback, shape);
        if (coerced !== null) {
            return { ok: true, value: coerced };
        }
    }
    if (shape === 'array') {
        return { ok: true, value: [] };
    }
    if (shape === 'boolean') {
        return { ok: true, value: false };
    }
    return parsed;
}

function coerceDefaultToShape(raw: string, shape: StructuredOutputShape): unknown | null {
    if (shape === 'boolean') {
        const lower = raw.trim().toLowerCase();
        if (lower === 'true' || lower === 'yes') return true;
        if (lower === 'false' || lower === 'no') return false;
        return null;
    }
    if (shape === 'object' || shape === 'array') {
        try {
            const parsed = JSON.parse(raw);
            if (shape === 'object' ? !Array.isArray(parsed) && typeof parsed === 'object' : Array.isArray(parsed)) {
                return parsed;
            }
            return null;
        } catch {
            return null;
        }
    }
    return raw;
}

/**
 * Discover skills and project them to the system-prompt shape (name + description + location),
 * cached per graph run (WeakMap keyed on the per-run Blackboard). Hides skills with
 * `disableModelInvocation`. Never throws — a discovery failure yields an empty list so one bad
 * skill file cannot break every LLM turn. When `blackboard` is undefined (test fixtures), the
 * cache is bypassed.
 */
async function discoverPromptSkills(
    workspaceRoot: string,
    blackboard: Blackboard | undefined,
): Promise<readonly SystemPromptSkill[]> {
    if (blackboard === undefined) {
        return loadPromptSkillsUncached(workspaceRoot);
    }
    const freshManifest = await buildSkillManifest(workspaceRoot);
    const cached = skillCache.get(blackboard);
    if (cached !== undefined && manifestsEqual(cached.manifest, freshManifest)) {
        return cached.skills;
    }
    const skills = await loadPromptSkillsUncached(workspaceRoot);
    skillCache.set(blackboard, { skills, manifest: freshManifest });
    return skills;
}

async function loadPromptSkillsUncached(workspaceRoot: string): Promise<readonly SystemPromptSkill[]> {
    try {
        const result = await discoverSkills({ workspaceRoot });
        return result.skills
            .filter((skill) => !skill.disableModelInvocation)
            .map((skill) => ({
                name: skill.name,
                description: skill.description,
                ...(skill.filePath.length > 0 ? { location: skill.filePath } : {}),
            }));
    } catch {
        return [];
    }
}

/** Read the prior compaction summary from the Blackboard (written on a previous context.packed). */
function readPriorSummary(blackboard: Blackboard): ConversationSummary | undefined {
    const value = blackboard.get('context.summary');
    if (value === undefined || value === null || typeof value !== 'object') {
        return undefined;
    }
    if (!('goal' in value) || !('summarizedMessageCount' in value)) {
        return undefined;
    }
    return value as ConversationSummary;
}

function extractTurnResult(result: unknown): LlmActorTurnResult | undefined {
    if (result === null || typeof result !== 'object' || !('responseMessages' in result)) {
        return undefined;
    }
    const candidate = result as { text?: unknown; usage?: unknown; responseMessages?: unknown };
    const responseMessages = candidate.responseMessages;
    if (!Array.isArray(responseMessages)) {
        return undefined;
    }
    return {
        text: typeof candidate.text === 'string' ? candidate.text : '',
        usage: candidate.usage,
        responseMessages: responseMessages as readonly ModelMessage[],
    };
}

export type { AbgNodeRunner };
