export const appName = 'mission-control';
export const cliCommandName = 'mctrl';
export const sidecarBinaryName = 'mission-control-sidecar';
export const missionControlAuthFileEnvKey = 'MISSION_CONTROL_AUTH_FILE';
export const missionControlAuthSchemaURL = 'https://mission-control.local/auth.schema.json';

export const defaultModelProviderSelection = {
    providerID: 'mock',
    modelID: 'mission-control-demo',
} as const;

export const modelProviderCatalog = [
    {
        id: 'mock',
        name: 'Mock Provider',
        defaultModelID: 'mission-control-demo',
        authLabel: 'API key',
        models: [
            {
                id: 'mission-control-demo',
                name: 'Mission Control Demo',
                status: 'active',
                variants: [
                    {
                        id: 'default',
                        name: 'Default',
                        status: 'active',
                    },
                ],
            },
            {
                id: 'mission-control-fast',
                name: 'Mission Control Fast',
                status: 'active',
                variants: [
                    {
                        id: 'cheap',
                        name: 'Cheap',
                        status: 'active',
                    },
                ],
            },
        ],
    },
    {
        id: 'local',
        name: 'Local Sandbox',
        defaultModelID: 'local-echo',
        authLabel: 'API key',
        models: [
            {
                id: 'local-echo',
                name: 'Local Echo',
                status: 'active',
                variants: [
                    {
                        id: 'default',
                        name: 'Default',
                        status: 'active',
                    },
                ],
            },
        ],
    },
] as const;
