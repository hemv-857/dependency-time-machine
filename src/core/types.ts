export type Ecosystem = 'npm' | 'pypi' | 'go' | 'cargo' | 'unknown';
export type ProjectType = 'node' | 'python' | 'go' | 'rust' | 'unknown';
export type BumpKind = 'major' | 'minor' | 'patch' | 'added' | 'removed' | 'changed';

export interface Lockfile {
  ecosystem: Ecosystem;
  path: string;
  /** package name -> exact installed version (top-most resolution wins) */
  packages: Record<string, string>;
}

export interface Manifest {
  ecosystem: Ecosystem;
  path: string;
  /** direct dependency ranges (dependencies + devDependencies merged) */
  dependencies: Record<string, string>;
  ownName?: string;
  ownVersion?: string;
  scripts?: Record<string, string>;
  files: string[];
}

export interface PkgChange {
  name: string;
  from?: string;
  to?: string;
  kind: BumpKind;
  links?: { label: string; href: string }[];
  advisories?: { id: string; severity: string; url: string }[];
}

export interface LockDiff {
  changes: PkgChange[];
  counts: { major: number; minor: number; patch: number; changed: number; added: number; removed: number; total: number };
}

export interface OsvVuln {
  id: string;
  aliases: string[];
  summary?: string;
  severity: string;
  url: string;
}

export interface Advisory extends OsvVuln {
  packages: string[];
}

export interface SecurityLens {
  available: boolean;
  /** vulns affecting the then-versions (i.e. existed at the time) */
  then: Advisory[];
  /** affected then, fixed by the version shipped now */
  fixed: Advisory[];
  /** affected both then and now */
  stillOpen: Advisory[];
}

export interface StoryCard {
  id: string;
  kind: 'major' | 'security' | 'release';
  title: string;
  date?: string;
  body: string;
  pkg?: string;
  from?: string;
  to?: string;
  links: { label: string; href: string }[];
}

export interface Story {
  headline: string;
  cards: StoryCard[];
}

export interface TimelinePoint {
  date: string;
  label: string;
  href?: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  date: string;
  body: string;
  url: string;
}

export interface ProjectInfo {
  type: ProjectType;
  ecosystem: Ecosystem;
  files: string[];
  readmePath?: string;
}

export type SnapshotStatus = 'queued' | 'analyzing' | 'building' | 'ready' | 'degraded' | 'failed';
export type PreviewMode = 'iframe' | 'readme' | 'none';

export interface Stage {
  name: string;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  startedAt: string;
  endedAt?: string;
  detail?: string;
}
