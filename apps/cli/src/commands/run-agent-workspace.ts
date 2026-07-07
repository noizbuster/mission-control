import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function detectWorkspaceRoot(): string {
    const cwd = process.cwd();
    let dir = cwd;
    for (let i = 0; i < 20; i++) {
        if (existsSync(join(dir, '.git'))) {
            return dir;
        }
        const pkgPath = join(dir, 'package.json');
        if (existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
                if (Array.isArray(pkg.workspaces) || typeof pkg.workspaces === 'object') {
                    return dir;
                }
            } catch (error: unknown) {
                if (!(error instanceof SyntaxError)) {
                    throw error;
                }
            }
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return cwd;
}

export function resolveWorkspaceRoot(explicitPath: string | undefined): string {
    if (explicitPath !== undefined) {
        const resolved = resolve(explicitPath);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
            throw new Error(`--workspace path does not exist or is not a directory: ${explicitPath}`);
        }
        return resolved;
    }
    const { MCTRL_WORKSPACE: envWorkspace } = process.env;
    if (envWorkspace !== undefined && envWorkspace.length > 0) {
        const resolved = resolve(envWorkspace);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
            throw new Error(`MCTRL_WORKSPACE path does not exist or is not a directory: ${envWorkspace}`);
        }
        return resolved;
    }
    return detectWorkspaceRoot();
}
