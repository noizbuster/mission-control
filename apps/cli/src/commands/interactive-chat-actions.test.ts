import { AgentRuntime, type Skill } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodingActionContext } from './interactive-chat-actions.js';
import { runChatAction } from './interactive-chat-actions.js';
import type { SessionNavigationController } from './interactive-chat-session-navigation.js';
import { SessionNavigationError } from './interactive-chat-session-navigation-store.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const currentSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
const switchedSelection: ModelProviderSelection = { providerID: 'openai', modelID: 'gpt-5.4' };

describe('interactive chat actions', () => {
    it('starts a new durable session through the navigation controller', async () => {
        const runtime = new AgentRuntime();
        const output = createOutput();
        const startNewSession = vi.fn(async () => ({
            message: 'Started new session: session_next\n',
            sessionId: 'session_next',
        }));
        const navigation = createNavigationController({ startNewSession });

        const result = await runChatAction(
            runtime,
            output,
            { kind: 'new-session', sessionId: 'session_next' },
            currentSelection,
            async () => undefined,
            [],
            createCodingContext({ sessionNavigation: navigation }),
        );

        expect(startNewSession).toHaveBeenCalledWith({
            modelProviderSelection: currentSelection,
            sessionId: 'session_next',
        });
        expect(output.getOutput()).toContain('Started new session: session_next');
        expect(result.sessionId).toBe('session_next');
    });

    it('switches the active session through the navigation controller', async () => {
        const runtime = new AgentRuntime();
        const output = createOutput();
        const navigation = createNavigationController({
            switchSession: async ({ sessionId }) => ({
                message: `Switched to session: ${sessionId}\n`,
                sessionId,
                modelProviderSelection: switchedSelection,
            }),
        });

        const result = await runChatAction(
            runtime,
            output,
            { kind: 'session', sessionId: 'session_other' },
            currentSelection,
            async () => undefined,
            [],
            createCodingContext({ sessionNavigation: navigation }),
        );

        expect(output.getOutput()).toContain('Switched to session: session_other');
        expect(result).toMatchObject({
            modelProviderSelection: switchedSelection,
            sessionId: 'session_other',
        });
        expect(result.persistModelProviderSelection).toBeUndefined();
    });

    it('lists durable sessions through the navigation controller', async () => {
        const runtime = new AgentRuntime();
        const output = createOutput();
        const listSessions = vi.fn(async () => ({ message: '* session_current\n  session_other\n' }));
        const navigation = createNavigationController({ listSessions });

        const result = await runChatAction(
            runtime,
            output,
            { kind: 'sessions' },
            currentSelection,
            async () => undefined,
            [],
            createCodingContext({ sessionNavigation: navigation }),
        );

        expect(listSessions).toHaveBeenCalledTimes(1);
        expect(output.getOutput()).toContain('* session_current');
        expect(result.modelProviderSelection).toEqual(currentSelection);
    });

    it('shows a session tree through the navigation controller', async () => {
        const runtime = new AgentRuntime();
        const output = createOutput();
        const showTree = vi.fn(async ({ sessionId }: { readonly sessionId?: string }) => ({
            message: `Session tree: ${sessionId ?? 'session_current'}\n`,
        }));
        const navigation = createNavigationController({ showTree });

        await runChatAction(
            runtime,
            output,
            { kind: 'tree', sessionId: 'session_other' },
            currentSelection,
            async () => undefined,
            [],
            createCodingContext({ sessionNavigation: navigation }),
        );

        expect(showTree).toHaveBeenCalledWith({ sessionId: 'session_other' });
        expect(output.getOutput()).toContain('Session tree: session_other');
    });

    it('selects a branch entry through the session tree controller', async () => {
        const runtime = new AgentRuntime();
        const output = createOutput();
        const selectBranch = vi.fn(async () => ({ message: 'Active branch: entry_leaf\n' }));
        const navigation = createNavigationController({ selectBranch });

        const result = await runChatAction(
            runtime,
            output,
            { kind: 'branch', mode: 'select', entryId: 'entry_leaf' },
            currentSelection,
            async () => undefined,
            [],
            createCodingContext({ sessionNavigation: navigation }),
        );

        expect(selectBranch).toHaveBeenCalledWith({
            entryId: 'entry_leaf',
            modelProviderSelection: currentSelection,
        });
        expect(output.getOutput()).toContain('Active branch: entry_leaf');
        expect(result.modelProviderSelection).toEqual(currentSelection);
    });

    it('forks a durable session through the navigation controller', async () => {
        const runtime = new AgentRuntime();
        const output = createOutput();
        const forkSession = vi.fn(async () => ({
            message: 'Forked session: session_child from entry_leaf\n',
            sessionId: 'session_child',
        }));
        const navigation = createNavigationController({ forkSession });

        const result = await runChatAction(
            runtime,
            output,
            { kind: 'fork', entryId: 'entry_leaf', sessionId: 'session_child' },
            currentSelection,
            async () => undefined,
            [],
            createCodingContext({ sessionNavigation: navigation }),
        );

        expect(forkSession).toHaveBeenCalledWith({
            entryId: 'entry_leaf',
            modelProviderSelection: currentSelection,
            sessionId: 'session_child',
        });
        expect(output.getOutput()).toContain('Forked session: session_child from entry_leaf');
        expect(result.sessionId).toBe('session_child');
    });

    it('clones a durable session through the navigation controller', async () => {
        const runtime = new AgentRuntime();
        const output = createOutput();
        const cloneSession = vi.fn(async () => ({
            message: 'Cloned session: session_clone\n',
            sessionId: 'session_clone',
        }));
        const navigation = createNavigationController({ cloneSession });

        const result = await runChatAction(
            runtime,
            output,
            { kind: 'clone', sessionId: 'session_clone' },
            currentSelection,
            async () => undefined,
            [],
            createCodingContext({ sessionNavigation: navigation }),
        );

        expect(cloneSession).toHaveBeenCalledWith({
            modelProviderSelection: currentSelection,
            sessionId: 'session_clone',
        });
        expect(output.getOutput()).toContain('Cloned session: session_clone');
        expect(result.sessionId).toBe('session_clone');
    });

    it.each([
        { action: { kind: 'new-session', sessionId: 'session_next' } },
        { action: { kind: 'sessions' } },
        { action: { kind: 'tree' } },
        { action: { kind: 'fork', entryId: 'entry_leaf', sessionId: 'session_child' } },
        { action: { kind: 'clone', sessionId: 'session_clone' } },
    ] as const)('refuses navigation command $action.kind while a run owner is active', async ({ action }) => {
        const runtime = new AgentRuntime();
        const output = createOutput();

        await runChatAction(
            runtime,
            output,
            action,
            currentSelection,
            async () => undefined,
            [],
            createCodingContext({
                activeTurn: {
                    done: Promise.resolve(),
                    interrupt: () => undefined,
                    answerApproval: () => false,
                    hasPendingApproval: () => false,
                },
                sessionNavigation: createNavigationController(),
            }),
        );

        expect(output.getOutput()).toContain('Interrupt the active run before switching sessions');
    });

    it('prints expected navigation validation errors instead of throwing', async () => {
        const runtime = new AgentRuntime();
        const output = createOutput();
        const navigation = createNavigationController({
            cloneSession: async () => {
                throw new SessionNavigationError('No durable session is active');
            },
        });

        const result = await runChatAction(
            runtime,
            output,
            { kind: 'clone' },
            currentSelection,
            async () => undefined,
            [],
            createCodingContext({ sessionNavigation: navigation }),
        );

        expect(output.getOutput()).toContain('No durable session is active');
        expect(result).toEqual({ modelProviderSelection: currentSelection });
    });

    it('rethrows unexpected navigation failures', async () => {
        const runtime = new AgentRuntime();
        const output = createOutput();
        const navigation = createNavigationController({
            cloneSession: async () => {
                throw new Error('unexpected navigation failure');
            },
        });

        await expect(
            runChatAction(
                runtime,
                output,
                { kind: 'clone' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ sessionNavigation: navigation }),
            ),
        ).rejects.toThrow('unexpected navigation failure');
        expect(output.getOutput()).toBe('');
    });

    it('rethrows unrelated TypeError navigation failures', async () => {
        const runtime = new AgentRuntime();
        const output = createOutput();
        const navigation = createNavigationController({
            cloneSession: async () => {
                throw new TypeError('internal type error');
            },
        });

        await expect(
            runChatAction(
                runtime,
                output,
                { kind: 'clone' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ sessionNavigation: navigation }),
            ),
        ).rejects.toThrow('internal type error');
        expect(output.getOutput()).toBe('');
    });

    describe('skill action (real loading)', () => {
        const tempRoots: string[] = [];

        afterEach(async () => {
            await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
            tempRoots.length = 0;
        });

        it('loads the real skill body and submits it as a prompt (no recorder event)', async () => {
            const runtime = new AgentRuntime();
            const spy = vi.spyOn(runtime, 'runSkillInvocationTask');
            const output = createOutput();
            const skill = await writeFixtureSkill('known-skill', 'Real skill body content.');
            tempRoots.push(skill.root);

            await runChatAction(
                runtime,
                output,
                { kind: 'skill', name: 'known-skill', instruction: 'extra args' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ skills: [skill.skill], activeTurn: fakeActiveTurn() }),
            );

            const captured = output.getOutput();
            expect(spy).not.toHaveBeenCalled();
            expect(captured).not.toContain('scaffolded');
            expect(captured).toContain('Loading skill "known-skill"');
            expect(captured).toContain('Queued follow-up:');
            expect(captured).toContain('<skill-instruction name="known-skill">');
            expect(captured).toContain('Real skill body content.');
            expect(captured).toContain('User request: extra args');
            expect(captured).toContain('</skill-instruction>');
        });

        it('expands a known skill via the $skill prefix path identically', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const skill = await writeFixtureSkill('planner', 'Plan the work steps.');
            tempRoots.push(skill.root);

            await runChatAction(
                runtime,
                output,
                { kind: 'skill', name: 'planner', instruction: 'draft a checklist' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ skills: [skill.skill], activeTurn: fakeActiveTurn() }),
            );

            const captured = output.getOutput();
            expect(captured).toContain('<skill-instruction name="planner">');
            expect(captured).toContain('Plan the work steps.');
            expect(captured).toContain('User request: draft a checklist');
        });

        it('reports a friendly unknown-skill message without throwing', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const skill = await writeFixtureSkill('known-skill', 'body');
            tempRoots.push(skill.root);

            await runChatAction(
                runtime,
                output,
                { kind: 'skill', name: 'missing-skill', instruction: '' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ skills: [skill.skill] }),
            );

            const captured = output.getOutput();
            expect(captured).toContain('Unknown skill: missing-skill');
            expect(captured).toContain('Available skills: known-skill');
            expect(captured).not.toContain('<skill-instruction');
        });

        it('reports unavailable skill loading when no skills are configured', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();

            await runChatAction(
                runtime,
                output,
                { kind: 'skill', name: 'anything', instruction: '' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({}),
            );

            expect(output.getOutput()).toContain('Skill loading unavailable');
        });

        it('reports empty discovered skill set cleanly', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();

            await runChatAction(
                runtime,
                output,
                { kind: 'skill', name: 'lonely', instruction: '' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ skills: [] }),
            );

            expect(output.getOutput()).toContain('Unknown skill: lonely');
            expect(output.getOutput()).toContain('(none discovered)');
        });
    });
});

function fakeActiveTurn(): NonNullable<CodingActionContext['activeTurn']> {
    return {
        done: Promise.resolve(),
        interrupt: () => undefined,
        answerApproval: () => false,
        hasPendingApproval: () => false,
    };
}

async function writeFixtureSkill(
    name: string,
    body: string,
): Promise<{ readonly root: string; readonly skill: Skill }> {
    const root = await mkdtemp(join(tmpdir(), 'skill-action-test-'));
    const skillDir = join(root, 'skills', name);
    await mkdir(skillDir, { recursive: true });
    const filePath = join(skillDir, 'SKILL.md');
    await writeFile(filePath, `---\nname: ${name}\ndescription: ${name} skill.\n---\n${body}`, 'utf8');
    const skill: Skill = {
        name,
        description: `${name} skill.`,
        disableModelInvocation: false,
        filePath,
        baseDir: dirname(filePath),
        sourceInfo: { scope: 'project', scopeId: 'project-mctrl', sourceDir: dirname(dirname(filePath)) },
    };
    return { root, skill };
}

function createCodingContext(overrides: Partial<CodingActionContext> = {}): CodingActionContext {
    return {
        activeTurn: overrides.activeTurn ?? undefined,
        commandExecutor: overrides.commandExecutor ?? undefined,
        emitEvent: overrides.emitEvent ?? undefined,
        nextTurnId: () => 'turn_test',
        observeStoredEvent: overrides.observeStoredEvent ?? undefined,
        provider: overrides.provider ?? undefined,
        sessionId: overrides.sessionId ?? 'session_current',
        sessionStore: overrides.sessionStore ?? undefined,
        workspaceRoot: overrides.workspaceRoot ?? '/workspace',
        ...(overrides.skills !== undefined ? { skills: overrides.skills } : {}),
        ...(overrides.sessionNavigation !== undefined ? { sessionNavigation: overrides.sessionNavigation } : {}),
    };
}

function createNavigationController(overrides: Partial<SessionNavigationController> = {}): SessionNavigationController {
    return {
        startNewSession: async () => ({ message: 'Started new session: session_next\n', sessionId: 'session_next' }),
        switchSession: async ({ sessionId }) => ({ message: `Switched to session: ${sessionId}\n`, sessionId }),
        listSessions: async () => ({ message: '  session_current\n' }),
        showSession: async () => ({ message: 'Session: session_current\n' }),
        showTree: async () => ({ message: 'Session tree: session_current\n' }),
        forkSession: async () => ({ message: 'Forked session: session_child\n', sessionId: 'session_child' }),
        cloneSession: async () => ({ message: 'Cloned session: session_clone\n', sessionId: 'session_clone' }),
        selectBranch: async () => ({ message: 'Active branch: entry_leaf\n' }),
        ...overrides,
    };
}

function createOutput() {
    const chunks: string[] = [];
    return {
        write: (text: string) => {
            chunks.push(text);
        },
        getOutput: () => chunks.join(''),
    };
}
