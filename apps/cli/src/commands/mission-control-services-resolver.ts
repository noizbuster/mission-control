import {
    getOrCreateMissionControlServices,
    isOmoRootNotFoundError,
    type MissionControlServices,
    type MissionControlServicesOptions,
} from './mission-control-services.js';

export async function resolveMissionControlServices(
    workspaceRoot: string,
    options?: MissionControlServicesOptions,
): Promise<MissionControlServices | undefined> {
    try {
        return await getOrCreateMissionControlServices(workspaceRoot, options);
    } catch (error: unknown) {
        if (isOmoRootNotFoundError(error)) return undefined;
        throw error;
    }
}
