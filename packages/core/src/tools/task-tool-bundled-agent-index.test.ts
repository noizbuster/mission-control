import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { AgentParseError } from '../agents/agent-parser';
import { buildBundledAgentIndexFromTemplates } from './task-tool-full-parity-factory';

describe('buildBundledAgentIndexFromTemplates', () => {
    it('records recoverable bundled agent parse failures and keeps valid agents', () => {
        const recoverableErrors: AgentParseError[] = [];
        const index = buildBundledAgentIndexFromTemplates({
            templates: ['valid', 'invalid'],
            parseAgent: (template) => {
                if (template === 'invalid') throw new AgentParseError('test parse failure', '<bundled>');
                return agent('deep', 'mctrl/task');
            },
            onRecoverableError: (error) => recoverableErrors.push(error),
        });
        expect(index.names()).toEqual(['deep']);
        expect(recoverableErrors).toHaveLength(1);
        expect(recoverableErrors[0]?.message).toBe('test parse failure');
    });

    it('rethrows unexpected bundled agent parse errors', () => {
        const unexpected = new TypeError('parser invariant broken');
        expect(() =>
            buildBundledAgentIndexFromTemplates({
                templates: ['broken'],
                parseAgent: () => {
                    throw unexpected;
                },
            }),
        ).toThrow(unexpected);
    });
});

function agent(name: string, model: AgentDefinition['model']): AgentDefinition {
    return {
        name,
        description: `${name} test agent`,
        systemPrompt: '',
        source: 'bundled',
        ...(model !== undefined ? { model } : {}),
    };
}
