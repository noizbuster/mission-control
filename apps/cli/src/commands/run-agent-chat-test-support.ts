import { missionControlAuthSchemaURL } from '@mission-control/config';
import type { ProviderAuthFile, ProviderCredentialSummary } from '@mission-control/protocol';
import type { ProviderAuthStore } from '../auth-store.js';

type ScriptedChatEvent =
    | {
          readonly type: 'line';
          readonly value: string;
      }
    | {
          readonly type: 'interrupt';
          readonly interruptedPartialInput?: boolean;
      };

export function createScriptedChatInput(events: readonly ScriptedChatEvent[], delayMs = 0) {
    let index = 0;
    return {
        read: async () => {
            if (delayMs > 0) {
                await new Promise((resolve) => {
                    setTimeout(resolve, delayMs);
                });
            }
            const event = events[index] ?? { type: 'interrupt' as const };
            index += 1;
            return event;
        },
        close: () => {},
    };
}

export function createBufferedChatOutput() {
    const chunks: string[] = [];
    return {
        output: {
            write: (text: string) => {
                chunks.push(text);
            },
            getOutput: () => chunks.join(''),
        },
        getOutput: () => chunks.join(''),
    };
}

export function createEmptyAuthStore(): ProviderAuthStore {
    return {
        authFilePath: '/tmp/mission-control-chat-test-auth.json',
        readAuthFile: async () => ({
            $schema: missionControlAuthSchemaURL,
            credentials: {},
        }),
        saveCredential: async () => {},
        setDefaultSelection: async () => {},
        deleteCredential: async () => {},
        listCredentialSummaries: async () => [],
        getDefaultSelection: async () => undefined,
    };
}

export function createAuthStoreWithSummaries(
    summaries: readonly ProviderCredentialSummary[],
    credentials: ProviderAuthFile['credentials'] = {},
): ProviderAuthStore {
    return {
        ...createEmptyAuthStore(),
        readAuthFile: async () => ({
            $schema: missionControlAuthSchemaURL,
            credentials,
        }),
        listCredentialSummaries: async () => summaries,
    };
}

export function createCredentialSummary(providerID: string): ProviderCredentialSummary {
    return {
        providerID,
        authenticated: true,
        maskedCredential: 'test...mary',
    };
}

export function createFieldsCredential(providerID: string, apiKey: string): ProviderAuthFile['credentials'][string] {
    return {
        providerID,
        type: 'fields',
        fields: {
            apiKey: {
                value: apiKey,
                secret: true,
            },
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };
}

type TtyState = {
    readonly input: boolean | undefined;
    readonly output: boolean | undefined;
};

export function setTtyState(state: TtyState): () => void {
    const inputDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const outputDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

    Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: state.input,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: state.output,
    });

    return () => {
        restoreProperty(process.stdin, 'isTTY', inputDescriptor);
        restoreProperty(process.stdout, 'isTTY', outputDescriptor);
    };
}

function restoreProperty(
    target: NodeJS.ReadStream | NodeJS.WriteStream,
    property: 'isTTY',
    descriptor: PropertyDescriptor | undefined,
): void {
    if (descriptor === undefined) {
        Reflect.deleteProperty(target, property);
        return;
    }
    Object.defineProperty(target, property, descriptor);
}
