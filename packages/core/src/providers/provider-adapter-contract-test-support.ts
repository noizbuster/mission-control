import type { ProviderAdapterFamily, ProviderExecutionCapability } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';

export const providerAdapterContractScenarios = [
    'requestFormation',
    'toolsAdvertised',
    'toolCallParsed',
    'toolResultContinuation',
    'finalMessage',
    'abort',
    'retryableError',
    'authFailure',
    'redaction',
] as const;

export type ProviderAdapterContractScenario = (typeof providerAdapterContractScenarios)[number];

export type ProviderAdapterContractRegistration = {
    readonly adapterFamily: ProviderAdapterFamily;
    readonly providerIDs: readonly string[];
    readonly scenarioProofs: Readonly<Record<ProviderAdapterContractScenario, string>>;
};

export type ProviderAdapterContractCatalogEntry = {
    readonly id: string;
    readonly capability: ProviderExecutionCapability;
};

export function describeProviderAdapterContract(registration: ProviderAdapterContractRegistration): void {
    describe(`${registration.adapterFamily} provider adapter contract`, () => {
        it('declares at least one executable provider covered by this adapter family', () => {
            expect(registration.providerIDs.length).toBeGreaterThan(0);
        });

        it.each(providerAdapterContractScenarios)('declares %s contract proof', (scenario) => {
            expect(registration.scenarioProofs[scenario]).toEqual(expect.stringMatching(/\S/));
        });
    });
}

export function findExecutableProviderContractGaps(
    catalog: readonly ProviderAdapterContractCatalogEntry[],
    registrations: readonly ProviderAdapterContractRegistration[],
): readonly string[] {
    const registrationsByProviderID = new Map<string, ProviderAdapterContractRegistration>();
    for (const registration of registrations) {
        for (const providerID of registration.providerIDs) {
            registrationsByProviderID.set(providerID, registration);
        }
    }

    const gaps: string[] = [];
    for (const entry of catalog) {
        if (entry.capability.status !== 'executable') {
            continue;
        }
        const registration = registrationsByProviderID.get(entry.id);
        if (registration === undefined) {
            gaps.push(`${entry.id}: missing provider adapter contract`);
            continue;
        }
        if (entry.capability.adapterFamily === undefined) {
            gaps.push(`${entry.id}: executable capability lacks adapter family`);
            continue;
        }
        if (registration.adapterFamily !== entry.capability.adapterFamily) {
            gaps.push(
                `${entry.id}: expected ${entry.capability.adapterFamily} contract, got ${registration.adapterFamily}`,
            );
        }
    }
    return [...gaps].sort();
}
