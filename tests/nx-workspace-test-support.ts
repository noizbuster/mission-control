import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

type JsonObject = Record<string, unknown>;

type RootManifest = {
    readonly scripts?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
};

type TuiManifest = {
    readonly scripts?: Record<string, string>;
};

type NxConfig = {
    readonly namedInputs?: JsonObject;
    readonly targetDefaults?: JsonObject;
};

type ProjectConfig = {
    readonly name?: string;
    readonly targets?: JsonObject;
    readonly implicitDependencies?: readonly string[];
};

function readJson(path: string): unknown {
    return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

export function readRootManifest(): RootManifest {
    const parsed = readJson('package.json');
    if (!isRootManifest(parsed)) {
        throw new Error('package.json is not a root manifest');
    }
    return parsed;
}

export function readTuiManifest(): TuiManifest {
    const parsed = readJson('apps/tui/package.json');
    if (!isTuiManifest(parsed)) {
        throw new Error('apps/tui/package.json is not a TUI manifest');
    }
    return parsed;
}

export function readNxConfig(): NxConfig {
    const parsed = readJson('nx.json');
    if (!isNxConfig(parsed)) {
        throw new Error('nx.json is not an Nx config');
    }
    return parsed;
}

export function readProjectConfig(path: string): ProjectConfig {
    const parsed = readJson(path);
    if (!isProjectConfig(parsed)) {
        throw new Error(`${path} is not an Nx project config`);
    }
    return parsed;
}

export function readTargetCommand(config: ProjectConfig, target: string): string | undefined {
    const targetConfig = config.targets?.[target];
    if (!isRecord(targetConfig)) {
        return undefined;
    }
    const options = Reflect.get(targetConfig, 'options');
    if (!isRecord(options)) {
        return undefined;
    }
    const command = Reflect.get(options, 'command');
    return typeof command === 'string' ? command : undefined;
}

export function readTargetCwd(config: ProjectConfig, target: string): string | undefined {
    const targetConfig = config.targets?.[target];
    if (!isRecord(targetConfig)) {
        return undefined;
    }
    const options = Reflect.get(targetConfig, 'options');
    if (!isRecord(options)) {
        return undefined;
    }
    const cwd = Reflect.get(options, 'cwd');
    return typeof cwd === 'string' ? cwd : undefined;
}

function isRootManifest(value: unknown): value is RootManifest {
    if (!isRecord(value)) {
        return false;
    }
    const scripts = Reflect.get(value, 'scripts');
    const devDependencies = Reflect.get(value, 'devDependencies');
    return (
        (scripts === undefined || isStringRecord(scripts)) &&
        (devDependencies === undefined || isStringRecord(devDependencies))
    );
}

function isTuiManifest(value: unknown): value is TuiManifest {
    if (!isRecord(value)) {
        return false;
    }
    const scripts = Reflect.get(value, 'scripts');
    return scripts === undefined || isStringRecord(scripts);
}

function isNxConfig(value: unknown): value is NxConfig {
    if (!isRecord(value)) {
        return false;
    }
    const namedInputs = Reflect.get(value, 'namedInputs');
    const targetDefaults = Reflect.get(value, 'targetDefaults');
    return (
        (namedInputs === undefined || isRecord(namedInputs)) &&
        (targetDefaults === undefined || isRecord(targetDefaults))
    );
}

function isProjectConfig(value: unknown): value is ProjectConfig {
    if (!isRecord(value)) {
        return false;
    }
    const name = Reflect.get(value, 'name');
    const targets = Reflect.get(value, 'targets');
    const implicitDependencies = Reflect.get(value, 'implicitDependencies');
    return (
        (name === undefined || typeof name === 'string') &&
        (targets === undefined || isRecord(targets)) &&
        (implicitDependencies === undefined || isStringArray(implicitDependencies))
    );
}

function isRecord(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (!isRecord(value)) {
        return false;
    }
    return Object.values(value).every((item) => typeof item === 'string');
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
