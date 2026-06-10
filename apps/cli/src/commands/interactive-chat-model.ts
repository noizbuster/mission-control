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
        return provider.models.flatMap((model) => {
            const variants = model.variants ?? [];
            if (variants.length === 0) {
                return [createModelChoice({ providerID: provider.id, modelID: model.id })];
            }
            return variants.map((variant) =>
                createModelChoice({ providerID: provider.id, modelID: model.id, variantID: variant.id }),
            );
        });
    });
}

export function resolveModelCommand(
    input: string,
    currentSelection: ModelProviderSelection,
    options: ResolveModelCommandOptions = {},
): ModelCommandResult {
    const trimmed = input.trim();
    if (trimmed.length === 0 || trimmed === 'pick') {
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
    const provider = catalog.find((entry) => entry.id === selection.providerID);
    if (!choices.some((choice) => choice.selection.providerID === selection.providerID)) {
        if (provider !== undefined) {
            return {
                type: 'invalid',
                message: `Provider is not logged in: ${selection.providerID}`,
                currentSelection,
            };
        }
    }
    const model = provider?.models.find((entry) => entry.id === selection.modelID);
    if (selection.variantID !== undefined && hasVariantCatalog(model)) {
        const variantExists = model.variants.some((variant) => variant.id === selection.variantID);
        if (!variantExists) {
            return {
                type: 'invalid',
                message: `Variant ${selection.variantID} is not available for model ${selection.providerID}/${selection.modelID}`,
                currentSelection,
            };
        }
    }
    if (!choices.some((choice) => isSelectionAvailable(choice.selection, selection))) {
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
    return `${selection.providerID}/${selection.modelID}${selection.variantID === undefined ? '' : `#${selection.variantID}`}`;
}

function parseModelSelectionInput(input: string): ModelProviderSelection | undefined {
    const parts = input.split(/\s+/).filter((part) => part.length > 0);
    if (parts.length === 1) {
        return parseProviderModelShorthand(parts[0] ?? '');
    }
    if (parts.length === 2) {
        const providerID = parts[0];
        const modelInput = parts[1];
        if (providerID === undefined || modelInput === undefined) {
            return undefined;
        }
        return selectionFromProviderAndModel(providerID, modelInput);
    }
    if (parts.length === 3) {
        const providerID = parts[0];
        const modelID = parts[1];
        const variantID = parts[2];
        if (providerID === undefined || modelID === undefined || variantID === undefined) {
            return undefined;
        }
        return { providerID, modelID, variantID };
    }
    return undefined;
}

function parseProviderModelShorthand(input: string): ModelProviderSelection | undefined {
    const slashIndex = input.indexOf('/');
    if (slashIndex <= 0 || slashIndex === input.length - 1) {
        return undefined;
    }
    return selectionFromProviderAndModel(input.slice(0, slashIndex), input.slice(slashIndex + 1));
}

function selectionFromProviderAndModel(providerID: string, modelInput: string): ModelProviderSelection | undefined {
    const parsed = splitModelVariant(modelInput);
    if (parsed === undefined) {
        return undefined;
    }
    return {
        providerID,
        modelID: parsed.modelID,
        ...(parsed.variantID !== undefined ? { variantID: parsed.variantID } : {}),
    };
}

function splitModelVariant(modelInput: string): { readonly modelID: string; readonly variantID?: string } | undefined {
    const variantSeparatorIndex = modelInput.lastIndexOf('#');
    if (variantSeparatorIndex < 0) {
        return { modelID: modelInput };
    }
    if (variantSeparatorIndex === 0 || variantSeparatorIndex === modelInput.length - 1) {
        return undefined;
    }
    return {
        modelID: modelInput.slice(0, variantSeparatorIndex),
        variantID: modelInput.slice(variantSeparatorIndex + 1),
    };
}

function createModelChoice(selection: ModelProviderSelection): ModelChoice {
    const label = formatModelSelection(selection);
    return {
        id: label,
        label,
        selection,
    };
}

function isSelectionAvailable(available: ModelProviderSelection, requested: ModelProviderSelection): boolean {
    if (available.providerID !== requested.providerID || available.modelID !== requested.modelID) {
        return false;
    }
    if (requested.variantID === undefined) {
        return true;
    }
    if (available.variantID === undefined) {
        return true;
    }
    return available.variantID === requested.variantID;
}

function hasVariantCatalog(
    model: ModelProviderCatalogEntry['models'][number] | undefined,
): model is ModelProviderCatalogEntry['models'][number] & {
    readonly variants: NonNullable<ModelProviderCatalogEntry['models'][number]['variants']>;
} {
    return model?.variants !== undefined && model.variants.length > 0;
}
