import { Manifest } from '@/core/types';

export type BuildMode = 'build' | 'test' | 'readme';

export interface BuildPlan {
  mode: BuildMode;
  toolchain: 'node' | 'python';
  /** commands run inside the project dir, in order */
  steps: { name: string; cmd: string; timeoutMs: number }[];
  /** dirs to probe for static output after build */
  outDirs: string[];
  startScript: boolean;
}

export const BUILD_TIMEOUT_MS = Number(process.env.TM_BUILD_TIMEOUT_MS || 180_000);
export const TEST_TIMEOUT_MS = 90_000;

/** Decide how (or whether) a project at a snapshot can be made runnable. */
export function planBuild(info: {
  type: string;
  manifest: Manifest | null;
  hasLockfile: boolean;
}): BuildPlan | null {
  if (info.type !== 'node' || !info.manifest) return null;
  const scripts = info.manifest.scripts || {};
  const deps = Object.keys(info.manifest.dependencies).length;
  const installCmd = `npm ${info.hasLockfile ? 'ci' : 'install'} --no-audit --no-fund --loglevel=error`;

  if (scripts.build || scripts.start) {
    const steps: BuildPlan['steps'] = [];
    if (deps > 0) steps.push({ name: 'install', cmd: installCmd, timeoutMs: BUILD_TIMEOUT_MS });
    if (scripts.build) steps.push({ name: 'build', cmd: 'npm run build', timeoutMs: BUILD_TIMEOUT_MS });
    return {
      mode: 'build',
      toolchain: 'node',
      steps,
      outDirs: ['build', 'dist', 'out', '.output/public', '_site', 'public'],
      startScript: !!scripts.start,
    };
  }
  if (scripts.test) {
    const steps: BuildPlan['steps'] = [];
    if (deps > 0) steps.push({ name: 'install', cmd: installCmd, timeoutMs: BUILD_TIMEOUT_MS });
    steps.push({ name: 'test', cmd: 'npm test', timeoutMs: TEST_TIMEOUT_MS });
    return { mode: 'test', toolchain: 'node', steps, outDirs: [], startScript: false };
  }
  return null;
}
