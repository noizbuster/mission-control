import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createAuthStoreWithSummaries,
    createBufferedChatOutput,
    createCredentialSummary,
    createFieldsCredential,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';

describe('runAgent /model provider capability', () => {
    it('shows authenticated discovery-only providers but rejects them for coding selection', async () => {
        const chatOutput = createBufferedChatOutput();
        const fieldSecret = 'perplexity_secret_key';
        const oauthAccessToken = 'oauth_access_secret';
        const oauthRefreshToken = 'oauth_refresh_secret';

        const output = await runAgent(parseArgs([]), {
            authStore: createAuthStoreWithSummaries(
                [createCredentialSummary('perplexity'), createCredentialSummary('openai')],
                {
                    perplexity: createFieldsCredential('perplexity', fieldSecret),
                    openai: {
                        providerID: 'openai',
                        type: 'oauth',
                        accessToken: oauthAccessToken,
                        refreshToken: oauthRefreshToken,
                        createdAt: '2026-01-01T00:00:00.000Z',
                        updatedAt: '2026-01-01T00:00:00.000Z',
                    },
                },
            ),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model list' },
                { type: 'line', value: '/model perplexity/sonar' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            modelDiscovery: async () => undefined,
        });

        expect(output).toContain('perplexity/sonar [model-discovery-only: cannot run coding agent prompts]');
        expect(output).toContain('Provider perplexity is model-discovery-only and cannot run coding agent prompts');
        expect(output).toContain('selection: local/local-echo');
        expect(output).not.toContain('selection: perplexity/sonar');
        expect(output).not.toContain(fieldSecret);
        expect(output).not.toContain(oauthAccessToken);
        expect(output).not.toContain(oauthRefreshToken);
    });
});
