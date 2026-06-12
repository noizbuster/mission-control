import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import type { DesktopSessionLog } from './lib/agent-client.js';
import {
    formatProviderCapabilityStatus,
    getCredentialStatus,
    getModelsForProvider,
    getProviderExecutionGate,
    ProviderExecutionStatus,
    resolveSelectionForProviderChange,
} from './ProviderControls.js';
import { providerRunBlockMessage } from './useDesktopWriteActions.js';

describe('Desktop App', () => {
    it('renders mission-control title, controls, and read-only session timeline', () => {
        // Given
        const log = sessionLog({
            type: 'task.completed',
            timestamp: '2026-06-02T10:00:00.000Z',
            sessionId: 'session_test',
            taskId: 'task_1',
            message: 'completed by mock sidecar',
            nativeSidecarStatus: 'mock',
        });

        // When
        const html = renderToStaticMarkup(
            <App
                initialSessionId="session_test"
                initialSessionSummaries={[
                    {
                        sessionId: 'session_test',
                        fileName: 'session_test.jsonl',
                        state: 'available',
                        eventCount: 1,
                        diagnostics: [],
                    },
                ]}
                initialSessionLog={log}
            />,
        );

        // Then
        expect(html).toContain('mission-control');
        expect(html).toContain('session_test');
        expect(html).toContain('Refresh sessions');
        expect(html).toContain('Load session');
        expect(html).toContain('Session timeline');
        expect(html).toContain('task.completed');
        expect(html).toContain('completed by mock sidecar');
        expect(html).toContain('mock');
        expect(html).toContain('data-testid="active-model"');
        expect(html).toContain('model local/local-echo');
    });

    it('renders provider and model controls with the active selection', () => {
        const html = renderToStaticMarkup(<App />);

        expect(html).toContain('aria-label="provider"');
        expect(html).toContain('aria-label="model"');
        expect(html).toContain('aria-label="API key"');
        expect(html).toContain('Save credential');
        expect(html).toContain('Local Sandbox');
        expect(html).toContain('Local Echo');
        expect(html).toContain('model local/local-echo');
        expect(html).toContain('credential missing');
    });

    it('resolves model options when the provider changes', () => {
        expect(getModelsForProvider('local').map((model) => model.id)).toEqual(['local-echo']);
        expect(resolveSelectionForProviderChange('local', 'removed-model')).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
    });

    it('renders and resolves generated provider catalog options without assuming the full list', () => {
        const html = renderToStaticMarkup(<App />);

        expect(html).toContain('Local Sandbox');
        expect(html).toContain('Anthropic');
        expect(html).toContain('Cloudflare AI Gateway');
        expect(getModelsForProvider('anthropic').map((model) => model.id)).toContain('claude-3-5-haiku-20241022');
        expect(resolveSelectionForProviderChange('anthropic', 'removed-model')).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
        });
    });

    it('renders credential-aware provider setup state', () => {
        const html = renderToStaticMarkup(
            <App
                initialCredentialSummaries={[
                    {
                        providerID: 'local',
                        authenticated: true,
                        maskedCredential: 'loca..._key',
                    },
                ]}
            />,
        );

        expect(html).toContain('credential configured');
        expect(html).not.toContain('mc_test_key');
    });

    it('renders provider execution capability and redacted credential details', () => {
        const openAISelection = resolveSelectionForProviderChange('openai', 'removed-model');
        const unredactedCredential = ['fixture', 'token', 'value'].join('-');
        const html = renderToStaticMarkup(
            <App
                initialCredentialSummaries={[
                    {
                        providerID: 'openai',
                        authenticated: true,
                        credentialType: 'apiKey',
                        maskedCredential: 'sk-l...cret',
                    },
                ]}
                initialModelProviderSelection={openAISelection}
            />,
        );

        expect(html).toContain('data-testid="provider-execution-status"');
        expect(html).toContain('execution ready');
        expect(html).toContain('credential configured');
        expect(html).toContain('sk-l...cret');
        expect(html).not.toContain(unredactedCredential);
    });

    it('disables write-capable composer actions for non-executable providers', () => {
        const cloudflareSelection = resolveSelectionForProviderChange('cloudflare-ai-gateway', 'removed-model');
        const html = renderToStaticMarkup(
            <App initialSessionId="session_write" initialModelProviderSelection={cloudflareSelection} />,
        );

        expect(html).toContain('model discovery only');
        expect(html).toContain('run disabled: model discovery only');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Submit prompt<\/button>/);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Queue follow-up<\/button>/);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Steer<\/button>/);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Resume<\/button>/);
        expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Interrupt<\/button>/);
    });

    it('classifies desktop provider execution gates from the shared catalog', () => {
        const executableGate = getProviderExecutionGate('openai');
        const discoveryOnlyGate = getProviderExecutionGate('cloudflare-ai-gateway');
        const authOnlyGate = getProviderExecutionGate('github-copilot');

        expect(executableGate).toMatchObject({
            canStart: true,
            label: 'execution ready',
            status: 'executable',
        });
        expect(discoveryOnlyGate).toMatchObject({
            canStart: false,
            label: 'model discovery only',
            status: 'model-discovery-only',
        });
        expect(authOnlyGate).toMatchObject({
            canStart: false,
            label: 'auth only',
            status: 'auth-only',
        });
        expect(providerRunBlockMessage(executableGate)).toBeUndefined();
        expect(providerRunBlockMessage(discoveryOnlyGate)).toBe('run disabled: model discovery only');
        expect(providerRunBlockMessage(authOnlyGate)).toBe('run disabled: auth only');
        expect(formatProviderCapabilityStatus({ status: 'unsupported' })).toBe('unsupported');
        expect(
            renderToStaticMarkup(
                <ProviderExecutionStatus
                    gate={{
                        canStart: false,
                        label: 'unsupported',
                        message: 'run disabled: unsupported',
                        status: 'unsupported',
                    }}
                />,
            ),
        ).toContain('data-state="unsupported"');
    });

    it('marks configured providers as authenticated', () => {
        expect(
            getCredentialStatus('local', [
                {
                    providerID: 'local',
                    authenticated: true,
                    maskedCredential: 'loca..._key',
                },
            ]),
        ).toBe('credential configured');
        expect(
            getCredentialStatus('anthropic', [
                {
                    providerID: 'anthropic',
                    authenticated: true,
                    maskedCredential: 'anth..._key (1 field)',
                },
            ]),
        ).toBe('credential configured');
        expect(getCredentialStatus('openai', [])).toBe('credential missing');
    });
});

type EventInput = DesktopSessionLog['envelopes'][number]['event'];

function sessionLog(event: EventInput): DesktopSessionLog {
    return {
        sessionId: event.sessionId ?? 'session_test',
        state: 'available',
        contents: 'jsonl',
        diagnostics: [],
        envelopes: [
            {
                eventId: 'event_1',
                sequence: 0,
                createdAt: event.timestamp,
                sessionId: event.sessionId ?? 'session_test',
                durability: 'durable',
                event,
            },
        ],
    };
}
