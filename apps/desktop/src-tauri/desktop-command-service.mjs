import {
    createDesktopSessionCommandService,
    createProviderAuthStore,
    createProviderAuthStoreCredentialResolver,
    createProviderRouter,
} from '@mission-control/core';

const ACTION_METHODS = new Map([
    ['submitPrompt', 'submitPrompt'],
    ['queueFollowUp', 'queueFollowUp'],
    ['steerRun', 'steerRun'],
    ['resumeRun', 'resumeRun'],
    ['interruptRun', 'interruptRun'],
    ['decideApproval', 'decideApproval'],
    ['listProviderCredentials', 'listProviderCredentials'],
    ['saveProviderCredential', 'saveProviderCredential'],
]);

try {
    const request = parseRequest(JSON.parse(await readStdin()));
    const authStore = createProviderAuthStore();
    if (request.method === 'listProviderCredentials') {
        process.stdout.write(JSON.stringify(await authStore.listCredentialSummaries()));
    } else if (request.method === 'saveProviderCredential') {
        await authStore.saveCredential({
            providerID: readString(request.input, 'providerID'),
            modelID: readString(request.input, 'modelID'),
            ...readOptionalStringField(request.input, 'variantID'),
            apiKey: readString(request.input, 'apiKey'),
            now: new Date().toISOString(),
        });
        process.stdout.write(
            JSON.stringify(await savedCredentialSummary(authStore, readString(request.input, 'providerID'))),
        );
    } else {
        const credentialResolver = createProviderAuthStoreCredentialResolver(authStore);
        const provider = createProviderRouter(credentialResolver);
        const service = createDesktopSessionCommandService({
            dataDir: request.dataDir,
            workspaceRoot: request.workspaceRoot,
            provider,
        });
        const receipt = await service[request.method](request.input);
        process.stdout.write(JSON.stringify(receipt));
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
}

async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function parseRequest(value) {
    if (!isRecord(value)) {
        throw new Error('desktop command request must be an object');
    }
    const action = readString(value, 'action');
    const method = ACTION_METHODS.get(action);
    if (method === undefined) {
        throw new Error(`unsupported desktop command action: ${action}`);
    }
    const input = readRecord(value, 'input');
    return {
        method,
        input,
        dataDir: readString(value, 'dataDir'),
        workspaceRoot: readString(value, 'workspaceRoot'),
    };
}

function readRecord(value, key) {
    const field = value[key];
    if (!isRecord(field)) {
        throw new Error(`desktop command field ${key} must be an object`);
    }
    return field;
}

function readString(value, key) {
    const field = value[key];
    if (typeof field !== 'string' || field.length === 0) {
        throw new Error(`desktop command field ${key} must be a non-empty string`);
    }
    return field;
}

function readOptionalStringField(value, key) {
    const field = value[key];
    if (field === undefined) {
        return {};
    }
    if (typeof field !== 'string' || field.length === 0) {
        throw new Error(`desktop command field ${key} must be a non-empty string when provided`);
    }
    return { [key]: field };
}

async function savedCredentialSummary(authStore, providerID) {
    const summary = (await authStore.listCredentialSummaries()).find(
        (credential) => credential.providerID === providerID,
    );
    if (summary === undefined) {
        throw new Error(`saved credential summary missing for ${providerID}`);
    }
    return summary;
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
