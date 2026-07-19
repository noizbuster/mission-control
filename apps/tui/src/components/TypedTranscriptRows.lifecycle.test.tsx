/** @jsxImportSource @opentui/solid */

import { testRender } from '@opentui/solid';
import { describe, expect, it } from 'vitest';
import { TypedSubagentRow, TypedToolRow } from './TypedTranscriptRows';

describe('typed transcript lifecycle expansion', () => {
    it('shows settled one-line bodies while preserving active and multiline tool and subagent behavior', async () => {
        // Given: expanded tool and subagent rows spanning active/settled and one-line/multiline states.
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <TypedToolRow
                        part={{
                            id: 'tool-active-one',
                            type: 'inline-tool',
                            title: 'tool-active-one',
                            text: 'tool-active-one-body',
                            status: 'running',
                        }}
                        expanded={true}
                    />
                    <TypedToolRow
                        part={{
                            id: 'tool-active-many',
                            type: 'inline-tool',
                            title: 'tool-active-many',
                            text: 'tool-active-many-first\ntool-active-many-last',
                            status: 'running',
                        }}
                        expanded={true}
                    />
                    <TypedToolRow
                        part={{
                            id: 'tool-settled-one',
                            type: 'inline-tool',
                            title: 'tool-settled-one',
                            text: 'tool-settled-one-body',
                            status: 'completed',
                        }}
                        expanded={true}
                    />
                    <TypedToolRow
                        part={{
                            id: 'tool-settled-many',
                            type: 'inline-tool',
                            title: 'tool-settled-many',
                            text: 'tool-settled-many-first\ntool-settled-many-last',
                            status: 'completed',
                        }}
                        expanded={true}
                    />
                    <TypedSubagentRow
                        part={{
                            id: 'subagent-active-one',
                            type: 'subagent',
                            agentName: 'subagent-active-one',
                            text: 'subagent-active-one-body',
                            status: 'running',
                        }}
                        expanded={true}
                    />
                    <TypedSubagentRow
                        part={{
                            id: 'subagent-active-many',
                            type: 'subagent',
                            agentName: 'subagent-active-many',
                            text: 'subagent-active-many-first\nsubagent-active-many-last',
                            status: 'running',
                        }}
                        expanded={true}
                    />
                    <TypedSubagentRow
                        part={{
                            id: 'subagent-settled-one',
                            type: 'subagent',
                            agentName: 'subagent-settled-one',
                            text: 'subagent-settled-one-body',
                            status: 'completed',
                        }}
                        expanded={true}
                    />
                    <TypedSubagentRow
                        part={{
                            id: 'subagent-settled-many',
                            type: 'subagent',
                            agentName: 'subagent-settled-many',
                            text: 'subagent-settled-many-first\nsubagent-settled-many-last',
                            status: 'completed',
                        }}
                        expanded={true}
                    />
                </box>
            ),
            { width: 80, height: 40 },
        );

        try {
            // When: the expanded rows are mounted into the OpenTUI renderer.
            await setup.renderOnce();

            // Then: settled one-line bodies are visible, active one-line rows stay compact, and multiline paths retain their behavior.
            const frame = setup.captureCharFrame();
            expect(frame).not.toContain('tool-active-one-body');
            expect(frame).toContain('tool-active-many-last');
            expect(frame).toContain('tool-settled-one-body');
            expect(frame).toContain('tool-settled-many-last');
            expect(frame).not.toContain('subagent-active-one-body');
            expect(frame).not.toContain('subagent-active-many-last');
            expect(frame).toContain('subagent-settled-one-body');
            expect(frame).toContain('subagent-settled-many-last');
        } finally {
            setup.renderer.destroy();
        }
    });
});
