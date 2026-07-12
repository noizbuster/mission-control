import { getOrCreateMissionControlServices } from '../../apps/cli/dist/commands/mission-control-services.js';
import { openLocalSessionEventStore } from '../../packages/core/dist/index.js';

const workspaceRoot = process.env.MCTRL_WORKSPACE;
const sessionId = process.env.MCTRL_TASK12_DRAIN_SESSION_ID;
if (workspaceRoot === undefined || sessionId === undefined) {
    throw new TypeError('Task 12 drain preload requires workspace and session identifiers');
}

const services = await getOrCreateMissionControlServices(workspaceRoot);
const store = await openLocalSessionEventStore({ sessionId });
await store.append({
    type: 'session.started',
    timestamp: new Date().toISOString(),
    sessionId,
    message: 'Task 12 drain preload session',
    nativeSidecarStatus: 'mock',
    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
});
await store.close();
let releaseJob = () => {};
const jobRelease = new Promise((resolve) => {
    releaseJob = resolve;
});
services.getJobManager().startJob({
    sessionId,
    agentId: 'task-12-drain',
    blocking: false,
    execute: async () => {
        await jobRelease;
        return { status: 'completed', output: `drained ${sessionId}` };
    },
});
setImmediate(releaseJob);
