import { AgentRuntime, type Skill, WorkflowRegistry } from '@mission-control/core';
import type { ModelProviderSelection, WorkflowSpec } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodingActionContext } from './interactive-chat-actions.js';
import { runChatAction } from './interactive-chat-actions.js';
import type { SessionNavigationController } from './interactive-chat-session-navigation.js';
import { SessionNavigationError } from './interactive-chat-session-navigation-store.js';
import type { SessionPickerEntry } from './chat-store.js';
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
                    setApprovalLevel: () => undefined,
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

    describe('workflow action', () => {
        it('dispatches a known workflow by threading its graph through the prompt turn', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const registry = new WorkflowRegistry([
                createTestWorkflowSpec('planner'),
                createTestWorkflowSpec('runner'),
            ]);

            await runChatAction(
                runtime,
                output,
                { kind: 'workflow', name: 'planner', prompt: 'plan the migration' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({
                    workflowRegistry: registry,
                    activeTurn: fakeActiveTurn(),
                }),
            );

            const captured = output.getOutput();
            expect(captured).toContain('Running workflow "planner"');
            expect(captured).toContain('Queued follow-up:');
            expect(captured).toContain('plan the migration');
        });

        it('lists available workflows when the name is unknown', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const registry = new WorkflowRegistry([
                createTestWorkflowSpec('planner'),
                createTestWorkflowSpec('runner'),
            ]);

            await runChatAction(
                runtime,
                output,
                { kind: 'workflow', name: 'missing', prompt: 'do something' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ workflowRegistry: registry }),
            );

            const captured = output.getOutput();
            expect(captured).toContain('Unknown workflow: missing');
            expect(captured).toContain('Available workflows: planner, runner');
        });

        it('reports unavailable when no workflow registry is configured', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();

            await runChatAction(
                runtime,
                output,
                { kind: 'workflow', name: 'planner', prompt: 'plan X' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({}),
            );

            expect(output.getOutput()).toContain('Workflow invocation unavailable');
        });

        it('reports empty registry cleanly', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const registry = new WorkflowRegistry([]);

            await runChatAction(
                runtime,
                output,
                { kind: 'workflow', name: 'planner', prompt: 'plan X' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ workflowRegistry: registry }),
            );

            const captured = output.getOutput();
            expect(captured).toContain('Unknown workflow: planner');
            expect(captured).toContain('(none discovered)');
        });

        it('truncates available workflow list to 20 entries', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const specs = Array.from({ length: 25 }, (_, i) => createTestWorkflowSpec(`wf-${i}`));
            const registry = new WorkflowRegistry(specs);

            await runChatAction(
                runtime,
                output,
                { kind: 'workflow', name: 'missing', prompt: 'x' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ workflowRegistry: registry }),
            );

            const captured = output.getOutput();
            expect(captured).toContain('Unknown workflow: missing');
            expect(captured).toContain('wf-0, wf-1');
            expect(captured).not.toContain('wf-24');
        });
    });

    describe('/approval action', () => {
        it('applies the requested level to an active turn immediately', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const setApprovalLevel = vi.fn();
            const activeTurn = { ...fakeActiveTurn(), setApprovalLevel };

            const result = await runChatAction(
                runtime,
                output,
                { kind: 'approval', level: 'aggressive' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ activeTurn }),
            );

            expect(setApprovalLevel).toHaveBeenCalledWith('aggressive');
            expect(result.approvalLevel).toBe('aggressive');
            expect(output.getOutput()).toContain('applied to active run');
        });

        it('sets the level without an active turn', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();

            const result = await runChatAction(
                runtime,
                output,
                { kind: 'approval', level: 'safe' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({}),
            );

            expect(result.approvalLevel).toBe('safe');
            expect(output.getOutput()).toContain('Approval level set to: safe');
            expect(output.getOutput()).not.toContain('applied to active run');
        });

        it('reports the current level when no level is requested', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();

            await runChatAction(
                runtime,
                output,
                { kind: 'approval' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ approvalLevel: 'reckless' }),
            );

        expect(output.getOutput()).toContain('Approval level: reckless');
    });

    describe('/session picker action', () => {
        it('opens the picker, selects a session, and switches to it', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const switchSession = vi.fn(async ({ sessionId }: { readonly sessionId: string }) => ({
                message: `Switched to session: ${sessionId}\n`,
                sessionId,
            }));
            const navigation = createNavigationController({ switchSession });
            const selectSessionForAttach = vi.fn(async () => 's_x');
            const listWorkspaceSessions = vi.fn(async () => [pickerEntry('s_x', 'session x')]);

            const result = await runChatAction(
                runtime,
                output,
                { kind: 'session-picker' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ sessionNavigation: navigation, listWorkspaceSessions, selectSessionForAttach }),
            );

            expect(selectSessionForAttach).toHaveBeenCalledTimes(1);
            expect(switchSession).toHaveBeenCalledWith({ sessionId: 's_x' });
            expect(output.getOutput()).toContain('Switched to session: s_x');
            expect(result.sessionId).toBe('s_x');
        });

        it('writes a cancellation message without switching when the picker is dismissed', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const switchSession = vi.fn(async () => ({ message: '', sessionId: '' }));
            const navigation = createNavigationController({ switchSession });
            const selectSessionForAttach = vi.fn(async () => undefined);
            const listWorkspaceSessions = vi.fn(async () => [pickerEntry('s_x')]);

            await runChatAction(
                runtime,
                output,
                { kind: 'session-picker' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ sessionNavigation: navigation, listWorkspaceSessions, selectSessionForAttach }),
            );

            expect(switchSession).not.toHaveBeenCalled();
            expect(output.getOutput()).toContain('Cancelled.');
        });

        it('reports no sessions when the workspace list is empty', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const switchSession = vi.fn(async () => ({ message: '', sessionId: '' }));
            const navigation = createNavigationController({ switchSession });
            const selectSessionForAttach = vi.fn(async () => 's_x');
            const listWorkspaceSessions = vi.fn(async () => []);

            await runChatAction(
                runtime,
                output,
                { kind: 'session-picker' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ sessionNavigation: navigation, listWorkspaceSessions, selectSessionForAttach }),
            );

            expect(selectSessionForAttach).not.toHaveBeenCalled();
            expect(switchSession).not.toHaveBeenCalled();
            expect(output.getOutput()).toContain('No sessions found for this project.');
        });

        it('refuses switching while a run is active', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const navigation = createNavigationController();
            const selectSessionForAttach = vi.fn(async () => 's_x');
            const listWorkspaceSessions = vi.fn(async () => [pickerEntry('s_x')]);

            await runChatAction(
                runtime,
                output,
                { kind: 'session-picker' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({
                    activeTurn: fakeActiveTurn(),
                    sessionNavigation: navigation,
                    listWorkspaceSessions,
                    selectSessionForAttach,
                }),
            );

            expect(selectSessionForAttach).not.toHaveBeenCalled();
            expect(output.getOutput()).toContain('Interrupt the active run before switching sessions');
        });
    });

    describe('/resume last-session action', () => {
        it('switches to the most recent workspace session excluding the current one', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const switchSession = vi.fn(async ({ sessionId }: { readonly sessionId: string }) => ({
                message: `Switched to session: ${sessionId}\n`,
                sessionId,
            }));
            const navigation = createNavigationController({ switchSession });
            const listWorkspaceSessions = vi.fn(async () => [
                pickerEntry('session_current'),
                pickerEntry('session_prev'),
            ]);

            await runChatAction(
                runtime,
                output,
                { kind: 'resume' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({
                    sessionNavigation: navigation,
                    listWorkspaceSessions,
                    sessionId: 'session_current',
                }),
            );

            expect(switchSession).toHaveBeenCalledWith({ sessionId: 'session_prev' });
            expect(output.getOutput()).toContain('Switched to session: session_prev');
        });

        it('reports no previous session when only the current one exists', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const switchSession = vi.fn(async () => ({ message: '', sessionId: '' }));
            const navigation = createNavigationController({ switchSession });
            const listWorkspaceSessions = vi.fn(async () => [pickerEntry('session_current')]);

            await runChatAction(
                runtime,
                output,
                { kind: 'resume' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({
                    sessionNavigation: navigation,
                    listWorkspaceSessions,
                    sessionId: 'session_current',
                }),
            );

            expect(switchSession).not.toHaveBeenCalled();
            expect(output.getOutput()).toContain('No previous session for this project.');
        });

        it('reports no previous session when the workspace list is empty', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const switchSession = vi.fn(async () => ({ message: '', sessionId: '' }));
            const navigation = createNavigationController({ switchSession });
            const listWorkspaceSessions = vi.fn(async () => []);

            await runChatAction(
                runtime,
                output,
                { kind: 'resume' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({
                    sessionNavigation: navigation,
                    listWorkspaceSessions,
                    sessionId: 'session_current',
                }),
            );

            expect(switchSession).not.toHaveBeenCalled();
            expect(output.getOutput()).toContain('No previous session for this project.');
        });

        it('refuses switching while a run is active', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const switchSession = vi.fn(async () => ({ message: '', sessionId: '' }));
            const navigation = createNavigationController({ switchSession });
            const listWorkspaceSessions = vi.fn(async () => [pickerEntry('session_prev')]);

            await runChatAction(
                runtime,
                output,
                { kind: 'resume' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({
                    activeTurn: fakeActiveTurn(),
                    sessionNavigation: navigation,
                    listWorkspaceSessions,
                    sessionId: 'session_current',
                }),
            );

            expect(switchSession).not.toHaveBeenCalled();
            expect(output.getOutput()).toContain('Interrupt the active run before switching sessions');
        });
    });

    describe('/continue approval-resume action', () => {
        it('emits a resume request while a run is active (parity with former /resume)', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const emitEvent = vi.fn();

            await runChatAction(
                runtime,
                output,
                { kind: 'continue' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({
                    activeTurn: fakeActiveTurn(),
                    emitEvent,
                    sessionId: 'session_x',
                }),
            );

            expect(output.getOutput()).toContain('Resume requested for session_x');
        });

        it('writes a resume request when idle without a full session', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const emitEvent = vi.fn();

            await runChatAction(
                runtime,
                output,
                { kind: 'continue' },
                currentSelection,
                async () => undefined,
                [],
                createCodingContext({ emitEvent, sessionId: 'session_x' }),
            );

            expect(output.getOutput()).toContain('Resume requested for session_x');
        });
    });

    describe('session-less graceful guards', () => {
        it('writes a graceful message for /tree in a session-less state without throwing', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const showTree = vi.fn(async () => ({ message: 'should not reach\n' }));
            const navigation = createNavigationController({ showTree });
            const coding: CodingActionContext = {
                ...createCodingContext({ sessionNavigation: navigation }),
                sessionId: undefined,
            };

            const result = await runChatAction(
                runtime,
                output,
                { kind: 'tree' },
                currentSelection,
                async () => undefined,
                [],
                coding,
            );

            expect(showTree).not.toHaveBeenCalled();
            expect(output.getOutput()).toContain('No active session yet — send a prompt first.');
            expect(result).toEqual({ modelProviderSelection: currentSelection });
        });

        it('writes a graceful message for /fork in a session-less state', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const forkSession = vi.fn(async () => ({ message: '', sessionId: '' }));
            const navigation = createNavigationController({ forkSession });
            const coding: CodingActionContext = {
                ...createCodingContext({ sessionNavigation: navigation }),
                sessionId: undefined,
            };

            await runChatAction(
                runtime,
                output,
                { kind: 'fork', entryId: 'entry_x' },
                currentSelection,
                async () => undefined,
                [],
                coding,
            );

            expect(forkSession).not.toHaveBeenCalled();
            expect(output.getOutput()).toContain('No active session yet — send a prompt first.');
        });

        it('refuses /queue in a session-less idle state without enqueueing', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const emitEvent = vi.fn();
            const coding: CodingActionContext = {
                ...createCodingContext({ emitEvent }),
                sessionId: undefined,
            };

            await runChatAction(
                runtime,
                output,
                { kind: 'queue', prompt: 'hello' },
                currentSelection,
                async () => undefined,
                [],
                coding,
            );

            expect(emitEvent).not.toHaveBeenCalled();
            expect(output.getOutput()).toContain('Start a prompt first (no active session).');
        });

        it('refuses /steer in a session-less idle state without enqueueing', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const emitEvent = vi.fn();
            const coding: CodingActionContext = {
                ...createCodingContext({ emitEvent }),
                sessionId: undefined,
            };

            await runChatAction(
                runtime,
                output,
                { kind: 'steer', prompt: 'hello' },
                currentSelection,
                async () => undefined,
                [],
                coding,
            );

            expect(emitEvent).not.toHaveBeenCalled();
            expect(output.getOutput()).toContain('Start a prompt first (no active session).');
        });

        it('still enqueues /queue when an active turn exists', async () => {
            const runtime = new AgentRuntime();
            const output = createOutput();
            const emitEvent = vi.fn();
            const coding: CodingActionContext = {
                ...createCodingContext({ emitEvent, activeTurn: fakeActiveTurn() }),
                sessionId: undefined,
            };

            await runChatAction(
                runtime,
                output,
                { kind: 'queue', prompt: 'follow up' },
                currentSelection,
                async () => undefined,
                [],
                coding,
            );

            expect(emitEvent).toHaveBeenCalled();
            expect(output.getOutput()).toContain('Queued follow-up: follow up');
        });
    });
});

function pickerEntry(sessionId: string, label?: string): SessionPickerEntry {
    return {
        sessionId,
        label: label ?? sessionId,
        messageCount: 1,
        status: 'completed',
    };
}
});

function fakeActiveTurn(): NonNullable<CodingActionContext['activeTurn']> {
    return {
        done: Promise.resolve(),
        interrupt: () => undefined,
        answerApproval: () => false,
        hasPendingApproval: () => false,
        setApprovalLevel: () => undefined,
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

function createTestWorkflowSpec(name: string): WorkflowSpec {
    return {
        name,
        graph: {
            id: `${name}-graph`,
            entryNodeId: 'entry',
            nodes: [{ id: 'entry', kind: 'llm' }],
            edges: [],
            rules: [],
            policies: [],
        },
    };
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
        ...(overrides.workflowRegistry !== undefined ? { workflowRegistry: overrides.workflowRegistry } : {}),
        ...(overrides.approvalLevel !== undefined ? { approvalLevel: overrides.approvalLevel } : {}),
        ...(overrides.selectApprovalLevel !== undefined ? { selectApprovalLevel: overrides.selectApprovalLevel } : {}),
        ...(overrides.listWorkspaceSessions !== undefined
            ? { listWorkspaceSessions: overrides.listWorkspaceSessions }
            : {}),
        ...(overrides.selectSessionForAttach !== undefined
            ? { selectSessionForAttach: overrides.selectSessionForAttach }
            : {}),
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
