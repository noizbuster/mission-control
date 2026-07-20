/**
 * Team-core durable store: mailbox, task list, state, atomic locks, lifecycle.
 *
 * Clean-room reimplementation. Algorithm inspired by the team-mode domain
 * primitives of upstream agent harness (source-available license). No expression copied; the durable
 * layout (one directory per team run under `.omo/teams/`, atomic
 * temp-file-then-rename writes, an exclusive lockfile around the shared task
 * list) is reimplemented fresh against mission-control's persistence helpers.
 *
 * Storage layout (rooted at `.omo/teams/{teamRunId}/`):
 *   config.json          - declarative TeamSpec
 *   state.json           - runtime TeamState (members, lifecycle, lead)
 *   mailbox/{name}.jsonl - append-only inbox, one file per recipient
 *   tasklist.json        - shared task list (read-modify-write under a lock)
 *   tasklist.json.lock   - exclusive-create lockfile guarding task mutations
 *
 * Atomic task claiming: every task mutation acquires `tasklist.json.lock` via
 * `O_EXCL` create with a bounded retry loop and stale-lock reaping, then does
 * a read-modify-write of `tasklist.json`. Two concurrent claims on the same
 * task serialise through the lock; the loser observes the task already claimed
 * and is rejected, so exactly one claim succeeds.
 */

import {
    EMPTY_TASK_LIST,
    type MemberLifecycleState,
    type MemberRuntime,
    type MemberSpec,
    type TaskList,
    type TaskStatus,
    type TeamMessage,
    type TeamSpec,
    type TeamState,
    type TeamTask,
    taskListSchema,
    teamStateSchema,
} from './team-schemas';
import { randomUUID } from 'node:crypto';
import { mkdir, open, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const TEAMS_SUBDIR = 'teams';
const STATE_FILE = 'state.json';
const CONFIG_FILE = 'config.json';
const TASKLIST_FILE = 'tasklist.json';
const TASKLIST_LOCK = 'tasklist.json.lock';
const MAILBOX_DIR = 'mailbox';

const LOCK_RETRY_MS = 25;
const LOCK_BACKOFF_MAX_MS = 200;
const LOCK_STALE_AFTER_MS = 10_000;
const LOCK_DEFAULT_TIMEOUT_MS = 5_000;

export class TeamStoreError extends Error {
    constructor(
        message: string,
        readonly code: string,
        readonly path?: string,
    ) {
        super(message);
        this.name = 'TeamStoreError';
    }
}

/** Resolve the on-disk directory for one team run. */
export function teamDir(root: string, teamRunId: string): string {
    return join(root, '.omo', TEAMS_SUBDIR, teamRunId);
}

function mailboxPath(root: string, teamRunId: string, recipient: string): string {
    return join(teamDir(root, teamRunId), MAILBOX_DIR, `${recipient}.jsonl`);
}

function statePath(root: string, teamRunId: string): string {
    return join(teamDir(root, teamRunId), STATE_FILE);
}

function configPath(root: string, teamRunId: string): string {
    return join(teamDir(root, teamRunId), CONFIG_FILE);
}

function tasklistPath(root: string, teamRunId: string): string {
    return join(teamDir(root, teamRunId), TASKLIST_FILE);
}

function tasklistLockPath(root: string, teamRunId: string): string {
    return join(teamDir(root, teamRunId), TASKLIST_LOCK);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempPath, serialized, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, filePath);
    await rm(tempPath, { force: true });
}

async function ensureTeamDir(root: string, teamRunId: string): Promise<void> {
    await mkdir(join(teamDir(root, teamRunId), MAILBOX_DIR), { recursive: true });
}

// --- State + config persistence ------------------------------------------

export async function writeState(root: string, state: TeamState): Promise<void> {
    const validated = teamStateSchema.parse(state);
    await ensureTeamDir(root, state.teamRunId);
    await atomicWriteJson(statePath(root, state.teamRunId), validated);
}

export async function readState(root: string, teamRunId: string): Promise<TeamState> {
    const filePath = statePath(root, teamRunId);
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isEnoent(error)) {
            throw new TeamStoreError(`team state not found: ${teamRunId}`, 'team_not_found', filePath);
        }
        throw error;
    }
    const parsed: unknown = JSON.parse(contents);
    const result = teamStateSchema.safeParse(parsed);
    if (!result.success) {
        throw new TeamStoreError(`team state for ${teamRunId} failed validation`, 'team_corrupt', filePath);
    }
    return result.data;
}

export async function writeConfig(root: string, teamRunId: string, spec: TeamSpec): Promise<void> {
    await ensureTeamDir(root, teamRunId);
    await atomicWriteJson(configPath(root, teamRunId), spec);
}

/** Read-modify-write a single team state. Refreshes `updatedAt`. */
export async function updateState(
    root: string,
    teamRunId: string,
    mutator: (state: TeamState) => TeamState,
    now: () => string = () => new Date().toISOString(),
): Promise<TeamState> {
    const current = await readState(root, teamRunId);
    if (current.status === 'deleted') {
        throw new TeamStoreError(`team ${teamRunId} is deleted`, 'team_deleted');
    }
    const next = mutator({ ...current, updatedAt: now() });
    await writeState(root, next);
    return next;
}

// --- Member lifecycle helpers --------------------------------------------

export function findMember(state: TeamState, name: string): MemberRuntime | undefined {
    return state.members.find((member) => member.name === name);
}

export function requireMember(state: TeamState, name: string): MemberRuntime {
    const member = findMember(state, name);
    if (member === undefined) {
        throw new TeamStoreError(`member '${name}' not found in team ${state.teamRunId}`, 'member_not_found');
    }
    return member;
}

export function isLead(state: TeamState, memberName: string): boolean {
    return state.spec.leadAgentId === memberName;
}

/** A lead is the explicit `leadAgentId`, or the first member when none declared. */
export function resolveLeadName(state: TeamState): string {
    return state.spec.leadAgentId ?? state.members[0]?.name ?? '';
}

function toMemberRuntime(spec: MemberSpec, lifecycle: MemberLifecycleState): MemberRuntime {
    const base: MemberRuntime = {
        name: spec.name,
        kind: spec.kind,
        lifecycle,
        ...(spec.subagentType !== undefined ? { subagentType: spec.subagentType } : {}),
        ...(spec.category !== undefined ? { category: spec.category } : {}),
        ...(spec.role !== undefined ? { role: spec.role } : {}),
        ...(spec.prompt !== undefined ? { prompt: spec.prompt } : {}),
    };
    return base;
}

export function buildInitialState(
    teamRunId: string,
    spec: TeamSpec,
    leadSessionId: string,
    now: () => string = () => new Date().toISOString(),
): TeamState {
    const stamp = now();
    return {
        teamRunId,
        spec,
        leadSessionId,
        members: spec.members.map((member) => toMemberRuntime(member, 'spawning')),
        createdAt: stamp,
        updatedAt: stamp,
        status: 'active',
    };
}

// --- Mailbox -------------------------------------------------------------

/** Append one message to the recipient's mailbox file (created on demand). */
export async function appendMessage(
    root: string,
    teamRunId: string,
    recipient: string,
    message: TeamMessage,
): Promise<void> {
    const filePath = mailboxPath(root, teamRunId, recipient);
    await mkdir(dirname(filePath), { recursive: true });
    const line = `${JSON.stringify(message)}\n`;
    // O_APPEND on a jsonl file gives us the atomicity we need for single-writer
    // appends under POSIX; concurrent appends from different processes do not
    // interleave mid-line for writes under the pipe buffer size.
    const handle = await open(filePath, 'a');
    try {
        await handle.appendFile(line, 'utf8');
    } finally {
        await handle.close();
    }
}

export async function readMailbox(root: string, teamRunId: string, recipient: string): Promise<TeamMessage[]> {
    const filePath = mailboxPath(root, teamRunId, recipient);
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isEnoent(error)) return [];
        throw error;
    }
    const messages: TeamMessage[] = [];
    for (const line of contents.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
            messages.push(JSON.parse(trimmed) as TeamMessage);
        } catch {
            // Skip malformed lines rather than failing the whole read.
        }
    }
    return messages;
}

/** Count undelivered messages per recipient (best effort, for status). */
export async function mailboxCounts(root: string, teamRunId: string): Promise<Map<string, number>> {
    const dir = join(teamDir(root, teamRunId), MAILBOX_DIR);
    const counts = new Map<string, number>();
    try {
        for await (const entry of await opendir(dir)) {
            if (!entry.name.endsWith('.jsonl')) continue;
            const recipient = entry.name.slice(0, -'.jsonl'.length);
            const messages = await readMailbox(root, teamRunId, recipient);
            counts.set(recipient, messages.length);
        }
    } catch (error: unknown) {
        if (isEnoent(error)) return counts;
        throw error;
    }
    return counts;
}

// --- Task list with atomic locking --------------------------------------

/** Acquire an exclusive lockfile; retries with bounded backoff until timeout. */
async function withTaskListLock<T>(
    root: string,
    teamRunId: string,
    work: () => Promise<T>,
    timeoutMs: number = LOCK_DEFAULT_TIMEOUT_MS,
): Promise<T> {
    const lockPath = tasklistLockPath(root, teamRunId);
    const deadline = Date.now() + timeoutMs;
    let delay = LOCK_RETRY_MS;
    // We hold the lock by keeping a file handle open with O_EXCL. Releasing is
    // unlink. A lock older than LOCK_STALE_AFTER_MS is considered abandoned and
    // reaped so a crashed writer does not wedge the task list forever.
    let handle: import('node:fs/promises').FileHandle | undefined;
    try {
        while (true) {
            try {
                handle = await open(lockPath, 'wx');
                break;
            } catch (error: unknown) {
                if (!isEexist(error)) throw error;
                await reapStaleLock(lockPath);
                if (Date.now() >= deadline) {
                    throw new TeamStoreError(
                        `timed out acquiring task list lock for ${teamRunId}`,
                        'tasklist_lock_timeout',
                        lockPath,
                    );
                }
                await sleep(delay);
                delay = Math.min(LOCK_BACKOFF_MAX_MS, delay * 2);
            }
        }
        // Stamp the lock with the holder pid + acquisition time for stale reaping.
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`, 'utf8');
        return await work();
    } finally {
        if (handle !== undefined) {
            try {
                await handle.close();
            } catch {
                // Best effort; the unlink below is the real release.
            }
        }
        await rm(lockPath, { force: true });
    }
}

async function reapStaleLock(lockPath: string): Promise<void> {
    let contents: string;
    try {
        contents = await readFile(lockPath, 'utf8');
    } catch (error: unknown) {
        if (isEnoent(error)) return;
        return;
    }
    const lines = contents.split('\n');
    const acquiredAt = Number(lines[1] ?? '0');
    if (Number.isFinite(acquiredAt) && Date.now() - acquiredAt > LOCK_STALE_AFTER_MS) {
        await rm(lockPath, { force: true });
    }
}

async function readTaskList(root: string, teamRunId: string): Promise<TaskList> {
    const filePath = tasklistPath(root, teamRunId);
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isEnoent(error)) return { ...EMPTY_TASK_LIST, tasks: [] };
        throw error;
    }
    const parsed: unknown = JSON.parse(contents);
    const result = taskListSchema.safeParse(parsed);
    if (!result.success) {
        throw new TeamStoreError(`task list for ${teamRunId} failed validation`, 'tasklist_corrupt', filePath);
    }
    return result.data;
}

async function writeTaskList(root: string, teamRunId: string, list: TaskList): Promise<void> {
    await ensureTeamDir(root, teamRunId);
    await atomicWriteJson(tasklistPath(root, teamRunId), list);
}

export async function readTasks(root: string, teamRunId: string): Promise<readonly TeamTask[]> {
    return (await readTaskList(root, teamRunId)).tasks;
}

/** Create a task under the lock. Returns the new task. */
export async function createTask(
    root: string,
    teamRunId: string,
    params: { title: string; description?: string; dependencies?: readonly string[] },
): Promise<TeamTask> {
    const now = Date.now();
    const task: TeamTask = {
        taskId: `tt_${randomUUID()}`,
        title: params.title,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        dependencies: [...(params.dependencies ?? [])],
        ...(params.description !== undefined ? { description: params.description } : {}),
    };
    await withTaskListLock(root, teamRunId, async () => {
        const list = await readTaskList(root, teamRunId);
        list.tasks.push(task);
        await writeTaskList(root, teamRunId, list);
    });
    return task;
}

export type TaskClaimResult =
    | { readonly ok: true; readonly task: TeamTask }
    | {
          readonly ok: false;
          readonly reason: 'task_not_found' | 'already_claimed' | 'invalid_transition';
          readonly task?: TeamTask;
      };

const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
    open: ['claimed', 'completed', 'failed', 'deleted'],
    claimed: ['completed', 'failed', 'deleted', 'open'],
    completed: ['deleted'],
    failed: ['deleted', 'open'],
    deleted: [],
};

function transitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
    if (from === to) return true;
    return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Update a task under the atomic lock. When `status === 'claimed'` the caller
 * must pass `claimant`; the claim fails if the task is not `open` (or back in
 * `open` after a release). Concurrent claims serialise through the lockfile,
 * so exactly one claimant wins.
 */
export async function updateTask(
    root: string,
    teamRunId: string,
    taskId: string,
    change: { status: TaskStatus; owner?: string; claimant?: string },
): Promise<TaskClaimResult> {
    return withTaskListLock(root, teamRunId, async () => {
        const list = await readTaskList(root, teamRunId);
        const index = list.tasks.findIndex((task) => task.taskId === taskId);
        const current = index === -1 ? undefined : list.tasks[index];
        if (current === undefined || current.status === 'deleted') {
            return current === undefined
                ? { ok: false as const, reason: 'task_not_found' as const }
                : { ok: false as const, reason: 'task_not_found' as const, task: current };
        }
        if (change.status === 'claimed') {
            // Atomic claim: only an open (or released-to-open) task can be claimed,
            // and the claimant becomes the owner. Two concurrent claimants serialise
            // because only the first sees status === 'open' inside the lock.
            if (current.status !== 'open') {
                return { ok: false as const, reason: 'already_claimed' as const, task: current };
            }
            const claimant = change.claimant ?? change.owner;
            if (claimant === undefined) {
                return { ok: false as const, reason: 'invalid_transition' as const, task: current };
            }
            const claimed: TeamTask = {
                ...current,
                status: 'claimed',
                owner: claimant,
                updatedAt: Date.now(),
            };
            const nextTasks = list.tasks.map((task, idx) => (idx === index ? claimed : task));
            await writeTaskList(root, teamRunId, { ...list, tasks: nextTasks });
            return { ok: true as const, task: claimed };
        }
        if (!transitionAllowed(current.status, change.status)) {
            return { ok: false as const, reason: 'invalid_transition' as const, task: current };
        }
        // Non-claim mutations: owner optional, preserve existing owner.
        const ownerForNext = change.owner ?? current.owner;
        const nextTask: TeamTask = {
            ...current,
            status: change.status,
            updatedAt: Date.now(),
            ...(ownerForNext !== undefined && change.status !== 'open' ? { owner: ownerForNext } : {}),
        };
        // Releasing back to open clears the owner.
        if (change.status === 'open') {
            delete nextTask.owner;
        }
        const nextTasks = list.tasks.map((task, idx) => (idx === index ? nextTask : task));
        await writeTaskList(root, teamRunId, { ...list, tasks: nextTasks });
        return { ok: true as const, task: nextTask };
    });
}

export async function getTask(root: string, teamRunId: string, taskId: string): Promise<TeamTask | undefined> {
    const list = await readTaskList(root, teamRunId);
    return list.tasks.find((task) => task.taskId === taskId && task.status !== 'deleted');
}

// --- Listing + teardown --------------------------------------------------

export interface TeamListing {
    readonly teamRunId: string;
    readonly name: string;
    readonly status: TeamState['status'];
    readonly memberCount: number;
}

export async function listTeams(root: string): Promise<TeamListing[]> {
    const baseDir = join(root, '.omo', TEAMS_SUBDIR);
    const listings: TeamListing[] = [];
    try {
        for await (const entry of await opendir(baseDir)) {
            if (!entry.isDirectory()) continue;
            try {
                const state = await readState(root, entry.name);
                listings.push({
                    teamRunId: state.teamRunId,
                    name: state.spec.name,
                    status: state.status,
                    memberCount: state.members.length,
                });
            } catch {
                // Skip unreadable / partial directories.
            }
        }
    } catch (error: unknown) {
        if (isEnoent(error)) return [];
        throw error;
    }
    return listings;
}

/**
 * Tear down a team: mark state deleted, then remove the team directory and any
 * member worktrees. Worktree paths are read from state before deletion so each
 * can be cleaned up; failures to remove a worktree are reported but do not
 * block state teardown.
 */
export async function deleteTeam(
    root: string,
    teamRunId: string,
): Promise<{ removedWorktrees: string[]; worktreeErrors: string[] }> {
    const state = await readState(root, teamRunId);
    const removedWorktrees: string[] = [];
    const worktreeErrors: string[] = [];
    for (const member of state.members) {
        if (member.worktreePath !== undefined && member.worktreePath.length > 0) {
            try {
                await rm(member.worktreePath, { recursive: true, force: true });
                removedWorktrees.push(member.worktreePath);
            } catch (error: unknown) {
                worktreeErrors.push(error instanceof Error ? error.message : String(error));
            }
        }
    }
    const deleted: TeamState = { ...state, status: 'deleted', updatedAt: new Date().toISOString() };
    await writeState(root, deleted);
    await rm(teamDir(root, teamRunId), { recursive: true, force: true });
    return { removedWorktrees, worktreeErrors };
}

// --- Misc helpers --------------------------------------------------------

function isEnoent(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === 'ENOENT'
    );
}

function isEexist(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === 'EEXIST'
    );
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
