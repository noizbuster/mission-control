import {
    type TuiPluginCapabilityId,
    type TuiPluginCommandDescriptor,
    TuiPluginCommandDescriptorSchema,
    type TuiPluginDiagnostic,
    type TuiPluginManifest,
    TuiPluginManifestSchema,
    type TuiPluginRouteDescriptor,
    TuiPluginRouteDescriptorSchema,
    type TuiPluginSlotDescriptor,
    TuiPluginSlotDescriptorSchema,
} from '@mission-control/protocol';
import { type ProjectTrustLookup, ProjectTrustStore } from '../trust/project-trust-store.js';

export type TuiPluginSource = 'user' | 'project' | 'bundled';

export type TuiPluginHostRegistryOptions = {
    readonly workspaceRoot: string;
    readonly allowedCapabilities: readonly TuiPluginCapabilityId[];
    readonly trustLookup?: (workspaceRoot: string) => Promise<ProjectTrustLookup>;
    readonly now?: () => number;
};

export type TuiPluginLoadInput = {
    readonly source: TuiPluginSource;
    readonly manifest: unknown;
};

export type TuiPluginLoadResult =
    | {
          readonly status: 'loaded';
          readonly manifest: TuiPluginManifest;
          readonly diagnostics: readonly TuiPluginDiagnostic[];
          readonly hostApi: TuiPluginHostApi;
      }
    | {
          readonly status: 'blocked';
          readonly diagnostics: readonly TuiPluginDiagnostic[];
      };

export type TuiPluginHostApi = {
    readonly pluginName: string;
    readonly capabilities: readonly TuiPluginCapabilityId[];
    readonly registerSlot: (descriptor: TuiPluginSlotDescriptor) => TuiPluginRegistrationHandle;
    readonly registerRoute: (descriptor: TuiPluginRouteDescriptor) => TuiPluginRegistrationHandle;
    readonly registerCommand: (descriptor: TuiPluginCommandDescriptor) => TuiPluginRegistrationHandle;
};

export type TuiPluginRegistrationHandle = {
    readonly dispose: () => void;
};

type TuiPluginRegistrationKind = 'slot' | 'route' | 'command';

type TuiPluginRegistration = {
    readonly pluginName: string;
    readonly kind: TuiPluginRegistrationKind;
    readonly descriptor: TuiPluginSlotDescriptor | TuiPluginRouteDescriptor | TuiPluginCommandDescriptor;
};

export class TuiPluginHostRegistry {
    private readonly workspaceRoot: string;
    private readonly allowedCapabilities: ReadonlySet<TuiPluginCapabilityId>;
    private readonly trustLookup: (workspaceRoot: string) => Promise<ProjectTrustLookup>;
    private readonly now: () => number;
    private readonly registrations: TuiPluginRegistration[] = [];

    constructor(options: TuiPluginHostRegistryOptions) {
        this.workspaceRoot = options.workspaceRoot;
        this.allowedCapabilities = new Set(options.allowedCapabilities);
        this.trustLookup =
            options.trustLookup ?? ((workspaceRoot) => new ProjectTrustStore().getDecision(workspaceRoot));
        this.now = options.now ?? (() => Date.now());
    }

    async loadManifest(input: TuiPluginLoadInput): Promise<TuiPluginLoadResult> {
        const manifestResult = TuiPluginManifestSchema.safeParse(input.manifest);
        if (!manifestResult.success) {
            return {
                status: 'blocked',
                diagnostics: [
                    this.diagnostic('unknown-plugin', 'error', 'manifest_invalid', 'Plugin manifest is invalid'),
                ],
            };
        }

        const manifest = manifestResult.data;
        if (input.source === 'project') {
            const trust = await this.trustLookup(this.workspaceRoot);
            if (trust.decision !== 'trusted') {
                return {
                    status: 'blocked',
                    diagnostics: [
                        this.diagnostic(
                            manifest.name,
                            'warning',
                            'workspace_not_trusted',
                            'Project plugin is inert until workspace trust is granted',
                        ),
                    ],
                };
            }
        }

        this.disposePlugin(manifest.name);
        const diagnostics: TuiPluginDiagnostic[] = [];
        const grantedCapabilities = manifest.capabilities.filter((capability) =>
            this.allowedCapabilities.has(capability),
        );
        for (const capability of manifest.capabilities) {
            if (!this.allowedCapabilities.has(capability)) {
                diagnostics.push(
                    this.diagnostic(manifest.name, 'warning', 'capability_denied', `Capability denied: ${capability}`),
                );
            }
        }

        const hostApi = this.createHostApi(manifest.name, grantedCapabilities);
        for (const slot of manifest.slots) {
            if (grantedCapabilities.includes('ui.slot')) {
                hostApi.registerSlot(slot);
            }
        }
        for (const route of manifest.routes) {
            if (grantedCapabilities.includes('ui.route')) {
                hostApi.registerRoute(route);
            }
        }
        for (const command of manifest.commands) {
            if (grantedCapabilities.includes('ui.command')) {
                hostApi.registerCommand(command);
            }
        }

        return { status: 'loaded', manifest, diagnostics, hostApi };
    }

    listSlots(): readonly TuiPluginSlotDescriptor[] {
        return this.registrations.flatMap((registration) =>
            registration.kind === 'slot' ? [TuiPluginSlotDescriptorSchema.parse(registration.descriptor)] : [],
        );
    }

    listRoutes(): readonly TuiPluginRouteDescriptor[] {
        return this.registrations.flatMap((registration) =>
            registration.kind === 'route' ? [TuiPluginRouteDescriptorSchema.parse(registration.descriptor)] : [],
        );
    }

    listCommands(): readonly TuiPluginCommandDescriptor[] {
        return this.registrations.flatMap((registration) =>
            registration.kind === 'command' ? [TuiPluginCommandDescriptorSchema.parse(registration.descriptor)] : [],
        );
    }

    disposePlugin(pluginName: string): void {
        for (let index = this.registrations.length - 1; index >= 0; index -= 1) {
            if (this.registrations[index]?.pluginName === pluginName) {
                this.registrations.splice(index, 1);
            }
        }
    }

    private createHostApi(pluginName: string, capabilities: readonly TuiPluginCapabilityId[]): TuiPluginHostApi {
        return {
            pluginName,
            capabilities,
            registerSlot: (descriptor) =>
                this.register(pluginName, 'slot', TuiPluginSlotDescriptorSchema.parse(descriptor)),
            registerRoute: (descriptor) =>
                this.register(pluginName, 'route', TuiPluginRouteDescriptorSchema.parse(descriptor)),
            registerCommand: (descriptor) =>
                this.register(pluginName, 'command', TuiPluginCommandDescriptorSchema.parse(descriptor)),
        };
    }

    private register(
        pluginName: string,
        kind: TuiPluginRegistrationKind,
        descriptor: TuiPluginRegistration['descriptor'],
    ): TuiPluginRegistrationHandle {
        const registration = { pluginName, kind, descriptor } satisfies TuiPluginRegistration;
        this.registrations.push(registration);
        return {
            dispose: () => {
                const index = this.registrations.indexOf(registration);
                if (index >= 0) {
                    this.registrations.splice(index, 1);
                }
            },
        };
    }

    private diagnostic(
        pluginName: string,
        level: TuiPluginDiagnostic['level'],
        code: string,
        message: string,
    ): TuiPluginDiagnostic {
        return { pluginName, level, code, message, redacted: true, timestamp: this.now() };
    }
}
