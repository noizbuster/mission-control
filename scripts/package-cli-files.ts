import { cpSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function packageDestination(destinationNodeModules: string, packageName: string, stageDir: string): string {
    const destinationRoot = resolve(destinationNodeModules, ...packageName.split('/'));
    assertContainedPath(join(stageDir, 'node_modules'), destinationRoot, `destination for ${packageName}`);
    return destinationRoot;
}

export function assertContainedPath(parent: string, candidate: string, label: string): void {
    const relativePath = relative(parent, candidate);
    if (
        relativePath === '' ||
        (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
    ) {
        return;
    }
    throw new Error(`${label} escapes package root`);
}

export function copyContainedDirectory(root: string, source: string, destination: string): void {
    const canonicalRoot = realpathSync(root);
    const canonicalSource = realpathSync(source);
    assertContainedPath(canonicalRoot, canonicalSource, `source ${source}`);
    cpSync(canonicalSource, destination, {
        dereference: true,
        recursive: true,
        filter: (sourcePath) => {
            assertContainedPath(canonicalSource, realpathSync(sourcePath), `source ${sourcePath}`);
            return true;
        },
    });
}

export function copyExternalPackageDirectory(root: string, sourceRoot: string, destination: string): void {
    const canonicalRoot = realpathSync(root);
    const canonicalSourceRoot = realpathSync(sourceRoot);
    assertContainedPath(canonicalRoot, canonicalSourceRoot, `source ${sourceRoot}`);
    cpSync(canonicalSourceRoot, destination, {
        dereference: true,
        recursive: true,
        filter: (sourcePath) => {
            const relativeSource = relative(canonicalSourceRoot, sourcePath);
            if (relativeSource === 'node_modules' || relativeSource.startsWith(`node_modules${sep}`)) return false;
            assertContainedPath(canonicalSourceRoot, realpathSync(sourcePath), `source ${sourcePath}`);
            return true;
        },
    });
}
