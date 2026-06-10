import { appName } from '@mission-control/config';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const missionControlDataDirEnvKey = 'MCTRL_DATA_DIR';
const windowsAppDataEnvKey = 'APPDATA';
const xdgDataHomeEnvKey = 'XDG_DATA_HOME';

export type DataDirResolutionOptions = {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDir?: string;
    readonly platform?: NodeJS.Platform;
};

export function resolveMissionControlDataDir(options: DataDirResolutionOptions = {}): string {
    const env = options.env ?? process.env;
    const override = env[missionControlDataDirEnvKey];
    if (override !== undefined && override.length > 0) {
        return override;
    }

    const platform = options.platform ?? process.platform;
    const homeDir = options.homeDir ?? homedir();

    switch (platform) {
        case 'win32':
            return resolveWindowsDataDir(env, homeDir);
        case 'darwin':
            return join(homeDir, 'Library', 'Application Support', appName);
        default:
            return resolveUnixDataDir(env, homeDir);
    }
}

function resolveWindowsDataDir(env: Readonly<Record<string, string | undefined>>, homeDir: string): string {
    const appData = env[windowsAppDataEnvKey];
    const dataHome = appData !== undefined && appData.length > 0 ? appData : join(homeDir, 'AppData', 'Roaming');
    return join(dataHome, appName);
}

function resolveUnixDataDir(env: Readonly<Record<string, string | undefined>>, homeDir: string): string {
    const xdgDataHome = env[xdgDataHomeEnvKey];
    const dataHome =
        xdgDataHome !== undefined && xdgDataHome.length > 0 ? xdgDataHome : join(homeDir, '.local', 'share');
    return join(dataHome, appName);
}
