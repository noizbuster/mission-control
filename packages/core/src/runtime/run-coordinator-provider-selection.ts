import type { ModelProviderSelection } from '@mission-control/protocol';

export type ProviderTurnSelection =
    | {
          readonly providerID: string;
          readonly modelID: string;
      }
    | {
          readonly providerID: string;
          readonly modelID: string;
          readonly variantID: string;
      };

export function providerTurnSelection(selection: ModelProviderSelection): ProviderTurnSelection {
    return selection.variantID === undefined
        ? { providerID: selection.providerID, modelID: selection.modelID }
        : { providerID: selection.providerID, modelID: selection.modelID, variantID: selection.variantID };
}
