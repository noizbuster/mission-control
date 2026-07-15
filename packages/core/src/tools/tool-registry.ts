import { type ProtocolError, ToolDefinitionSchema } from '@mission-control/protocol';
import {
    commitToolSettlement,
    failedToolSettlement,
    invokeRegisteredTool,
    invokeToolRegistration,
    parseToolArgumentsJson,
    protocolError,
    versionHashFor,
} from './tool-registry-invocation';
import {
    type RegisteredTool,
    type ToolAdvertisement,
    type ToolInvocationInput,
    type ToolInvocationSettlement,
    type ToolRegistration,
    ToolRegistrationMetadataSchema,
} from './tool-registry-types';

export type {
    ToolAdvertisement,
    ToolExecutionContext,
    ToolInvocationInput,
    ToolInvocationSettlement,
    ToolModelOutput,
    ToolOutputLimit,
    ToolRegistration,
} from './tool-registry-types';
export { ToolExecutionError } from './tool-registry-types';

export type ToolInvocationPolicy = (
    advertisement: ToolAdvertisement,
    parsedArguments: unknown,
) => ProtocolError | undefined;

export class ToolRegistry {
    private readonly registrations = new Map<string, RegisteredTool>();

    constructor(private readonly invocationPolicy?: ToolInvocationPolicy) {}

    register<Input, Output>(registration: ToolRegistration<Input, Output>): ToolAdvertisement {
        const metadata = ToolRegistrationMetadataSchema.parse({
            name: registration.name,
            description: registration.description,
            capabilityClasses: registration.capabilityClasses,
            parametersJsonSchema: registration.parametersJsonSchema,
            outputLimit: registration.outputLimit,
            ...(registration.guideline !== undefined ? { guideline: registration.guideline } : {}),
        });
        const providerTool = ToolDefinitionSchema.parse({
            name: metadata.name,
            description: metadata.description,
            parametersJsonSchema: metadata.parametersJsonSchema,
        });
        const advertisement: ToolAdvertisement = {
            name: metadata.name,
            description: metadata.description,
            capabilityClasses: metadata.capabilityClasses,
            version: versionHashFor(metadata),
            outputLimit: metadata.outputLimit,
            providerTool,
            ...(metadata.guideline !== undefined ? { guideline: metadata.guideline } : {}),
        };
        this.registrations.set(metadata.name, {
            advertisement,
            invoke: (value, context) => invokeToolRegistration(registration, value, context),
        });
        return advertisement;
    }

    advertise(): readonly ToolAdvertisement[] {
        return [...this.registrations.values()].map((entry) => entry.advertisement);
    }

    /**
     * Return a NEW registry containing the entries whose advertisement passes `predicate`.
     * Copies the already-erased `RegisteredTool` entries directly (no re-validation), so a
     * heterogeneous parent surface can be filtered without re-asserting each registration's
     * Input/Output generics. Used by the subagent child-policy to drop the `task` tool +
     * destructive capabilities at the registry layer (ABG §10.6 recursion guard).
     */
    cloneWithFilter(
        predicate: (advertisement: ToolAdvertisement) => boolean,
        invocationPolicy: ToolInvocationPolicy | undefined = this.invocationPolicy,
    ): ToolRegistry {
        const child = new ToolRegistry(invocationPolicy);
        for (const [name, entry] of this.registrations) {
            if (predicate(entry.advertisement)) {
                child.registrations.set(name, entry);
            }
        }
        return child;
    }

    async invoke(input: ToolInvocationInput): Promise<ToolInvocationSettlement> {
        const registered = this.registrations.get(input.toolName);
        if (registered === undefined) {
            return commitToolSettlement(
                input,
                failedToolSettlement(input, protocolError('tool_failed', `unknown tool: ${input.toolName}`)),
            );
        }
        if (registered.advertisement.version !== input.advertisedVersion) {
            return commitToolSettlement(
                input,
                failedToolSettlement(
                    input,
                    protocolError('tool_failed', `stale tool call rejected: ${input.toolName}`),
                ),
            );
        }

        const parsedArguments = parseToolArgumentsJson(input);
        if (!parsedArguments.ok) {
            return commitToolSettlement(input, failedToolSettlement(input, parsedArguments.error));
        }
        const policyError = this.invocationPolicy?.(registered.advertisement, parsedArguments.value);
        if (policyError !== undefined) {
            return commitToolSettlement(input, failedToolSettlement(input, policyError));
        }
        return commitToolSettlement(input, await invokeRegisteredTool(registered, input, parsedArguments.value));
    }
}
