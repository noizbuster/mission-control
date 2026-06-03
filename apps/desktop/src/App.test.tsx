import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, getCredentialStatus, getModelsForProvider, resolveSelectionForProviderChange } from './App.js';

describe('Desktop App', () => {
    it('renders mission-control title, controls, and event log after demo task', () => {
        const html = renderToStaticMarkup(
            <App
                initialSessionId="session_test"
                initialEvents={[
                    {
                        type: 'task.completed',
                        timestamp: '2026-06-02T10:00:00.000Z',
                        taskId: 'task_1',
                        message: 'completed by mock sidecar',
                        nativeSidecarStatus: 'mock',
                    },
                ]}
            />,
        );

        expect(html).toContain('mission-control');
        expect(html).toContain('session_test');
        expect(html).toContain('Start demo session');
        expect(html).toContain('Run demo task');
        expect(html).toContain('task.completed');
        expect(html).toContain('completed by mock sidecar');
        expect(html).toContain('mock');
        expect(html).toContain('data-testid="active-model"');
        expect(html).toContain('model mock/mission-control-demo');
    });

    it('renders provider and model controls with the active selection', () => {
        const html = renderToStaticMarkup(<App />);

        expect(html).toContain('aria-label="provider"');
        expect(html).toContain('aria-label="model"');
        expect(html).toContain('aria-label="API key"');
        expect(html).toContain('Save credential');
        expect(html).toContain('Mock Provider');
        expect(html).toContain('Mission Control Demo');
        expect(html).toContain('model mock/mission-control-demo');
        expect(html).toContain('credential missing');
    });

    it('resolves model options when the provider changes', () => {
        expect(getModelsForProvider('local').map((model) => model.id)).toEqual(['local-echo']);
        expect(resolveSelectionForProviderChange('local', 'mission-control-demo')).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
        expect(resolveSelectionForProviderChange('mock', 'mission-control-fast')).toEqual({
            providerID: 'mock',
            modelID: 'mission-control-fast',
        });
    });

    it('renders credential-aware provider setup state', () => {
        const html = renderToStaticMarkup(
            <App
                initialCredentialSummaries={[
                    {
                        providerID: 'mock',
                        authenticated: true,
                        maskedCredential: 'mc_t..._key',
                    },
                ]}
            />,
        );

        expect(html).toContain('credential configured');
        expect(html).not.toContain('mc_test_key');
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
        expect(getCredentialStatus('mock', [])).toBe('credential missing');
    });
});
