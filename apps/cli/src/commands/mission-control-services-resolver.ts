import {
    getOrCreateMissionControlServices,
    isMcRootNotFoundError,
    type MissionControlServices,
    type MissionControlServicesOptions,
} from './mission-control-services';

export async function resolveMissionControlServices(
    workspaceRoot: string,
    options?: MissionControlServicesOptions,
): Promise<MissionControlServices | undefined> {
    try {
        return await getOrCreateMissionControlServices(workspaceRoot, options);
    } catch (error: unknown) {
        if (isMcRootNotFoundError(error)) return undefined;
        throw error;
    }
}
