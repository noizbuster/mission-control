import { satisfies, validRange } from 'semver';

export function assertPackageVersion(
    packageName: string,
    specifier: string,
    installedVersion: string | undefined,
): void {
    if (isSupportedNonSemverSpecifier(specifier)) return;
    if (validRange(specifier) === null) {
        throw new Error(`${packageName} has unsupported version specifier ${specifier}`);
    }
    if (installedVersion === undefined || !satisfies(installedVersion, specifier)) {
        throw new Error(
            `${packageName} installed version ${installedVersion ?? '<missing>'} does not satisfy ${specifier}`,
        );
    }
}

function isSupportedNonSemverSpecifier(specifier: string): boolean {
    return /^(?:workspace:|file:|link:|npm:|git(?:\+|:)|https?:)/u.test(specifier);
}
