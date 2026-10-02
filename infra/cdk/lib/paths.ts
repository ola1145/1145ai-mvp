import * as path from 'node:path';

/** cdk runs from infra/cdk (see cdk.json). Bundling resolves workspace packages from the repo root. */
export const REPO_ROOT = path.resolve(process.cwd(), '../..');
export const LOCK_FILE = path.join(REPO_ROOT, 'pnpm-lock.yaml');
export const fromRoot = (p: string) => path.join(REPO_ROOT, p);
export const bundlingProps = { projectRoot: REPO_ROOT, depsLockFilePath: LOCK_FILE } as const;
