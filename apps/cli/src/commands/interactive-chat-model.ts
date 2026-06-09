import { type ModelProviderCatalogEntry, modelProviderCatalog } from '@mission-control/config';
import type { ModelProviderSelection } from '@mission-control/protocol';

export type ModelChoice = {
    readonly id: string;
    readonly label: string;
    readonly selection: ModelProviderSelection;
};

export type ModelChoiceOptions = {
    readonly catalog?: readonly ModelProviderCatalogEntry[];
    readonly providerIDs?: readonly string[];
};

export type ResolveModelCommandOptions = ModelChoiceOptions & {
    readonly choices?: readonly ModelChoice[];
};

export type ModelCommandResult =
    | {
          readonly type: 'pick';
      }
    | {
          readonly type: 'select';
          readonly selection: ModelProviderSelection;
      }
    | {
          readonly type: 'list';
          readonly visibleChoices: readonly ModelChoice[];
          readonly totalCount: number;
      }
    | {
          readonly type: 'invalid';
          readonly message: string;
          readonly currentSelection: ModelProviderSelection;
      };

export function createModelChoices(options: ModelChoiceOptions = {}): readonly ModelChoice[] {
    const catalog = options.catalog ?? modelProviderCatalog;
    const providerIDs = options.providerIDs;
    return catalog.flatMap((provider) => {
        if (providerIDs !== undefined && !providerIDs.includes(provider.id)) {
            return [];
        }
        return provider.models.map((model) => {
            const selection = {
                providerID: provider.id,
                modelID: model.id,
            };
            return {
                id: formatModelSelection(selection),
                label: formatModelSelection(selection),
                selection,
            };
        });
    });
}

export function resolveModelCommand(
    input: string,
    currentSelection: ModelProviderSelection,
    options: ResolveModelCommandOptions = {},
): ModelCommandResult {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return { type: 'pick' };
    }
    const catalog = options.catalog ?? modelProviderCatalog;
    const choices =
        options.choices ??
        createModelChoices({
            catalog,
            ...(options.providerIDs !== undefined ? { providerIDs: options.providerIDs } : {}),
        });
    if (trimmed === 'list') {
        return {
            type: 'list',
            visibleChoices: choices.slice(0, 20),
            totalCount: choices.length,
        };
    }

    const selection = parseModelSelectionInput(trimmed);
    if (selection === undefined) {
        return {
            type: 'invalid',
            message: `Unknown model: ${trimmed}`,
            currentSelection,
        };
    }
    if (!choices.some((choice) => choice.selection.providerID === selection.providerID)) {
        const providerExists = catalog.some((provider) => provider.id === selection.providerID);
        if (providerExists) {
            return {
                type: 'invalid',
                message: `Provider is not logged in: ${selection.providerID}`,
                currentSelection,
            };
        }
    }
    if (!choices.some((choice) => isSameSelection(choice.selection, selection))) {
        return {
            type: 'invalid',
            message: `Unknown model: ${trimmed}`,
            currentSelection,
        };
    }
    return {
        type: 'select',
        selection,
    };
}

export function formatModelSelection(selection: ModelProviderSelection): string {
    return `${selection.providerID}/${selection.modelID}`;
}

function parseModelSelectionInput(input: string): ModelProviderSelection | undefined {
    const parts = input.split(/\s+/).filter((part) => part.length > 0);
    if (parts.length === 1) {
        return parseProviderModelShorthand(parts[0] ?? '');
    }
    if (parts.length === 2) {
        const providerID = parts[0];
        const modelID = parts[1];
        if (providerID === undefined || modelID === undefined) {
            return undefined;
        }
        return { providerID, modelID };
    }
    return undefined;
}

function parseProviderModelShorthand(input: string): ModelProviderSelection | undefined {
    const slashIndex = input.indexOf('/');
    if (slashIndex <= 0 || slashIndex === input.length - 1) {
        return undefined;
    }
    return {
        providerID: input.slice(0, slashIndex),
        modelID: input.slice(slashIndex + 1),
    };
}

function isSameSelection(left: ModelProviderSelection, right: ModelProviderSelection): boolean {
    return left.providerID === right.providerID && left.modelID === right.modelID;
}
