import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_SERVER = join(
    process.cwd(),
    'packages',
    'core',
    'src',
    'tools',
    'mcp',
    'fixtures',
    'stdio-fixture-server.mjs',
);

export const envRef = (name: string): string => `\${${name}}`;

export type TempDirs = { readonly root: string; readonly userConfigPath: string; readonly projectConfigPath: string };

export async function makeTempDirs(): Promise<TempDirs> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-mcp-'));
    return {
        root,
        userConfigPath: join(root, 'user', 'config.json'),
        projectConfigPath: join(root, 'workspace', '.mcp.json'),
    };
}

export async function writeRaw(path: string, contents: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents, 'utf8');
}
