/** Client-side mirrors of the API's public JSON shapes (no server imports). */

export interface PkgChange {
  name: string;
  from?: string;
  to?: string;
  kind: 'major' | 'minor' | 'patch' | 'added' | 'removed' | 'changed';
  links?: { label: string; href: string }[];
  advisories?: { id: string; severity: string; url: string }[];
}

export interface LockDiff {
  changes: PkgChange[];
  counts: { major: number; minor: number; patch: number; changed: number; added: number; removed: number; total: number };
}

export interface Advisory {
  id: string;
  aliases: string[];
  summary?: string;
  severity: string;
  url: string;
  packages: string[];
}

export interface SecurityLens {
  available: boolean;
  then: Advisory[];
  fixed: Advisory[];
  stillOpen: Advisory[];
}

export interface StoryCard {
  id: string;
  kind: 'major' | 'security' | 'release';
  title: string;
  date?: string;
  body: string;
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

export interface Stage {
  name: string;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  startedAt: string;
  endedAt?: string;
  detail?: string;
}

export interface PublicSnapshot {
  id: string;
  repo: { owner: string; name: string; fullName: string; htmlUrl: string | null };
  dateIso: string;
  commitDate: string;
  ref: string | null;
  commit: { sha: string; url: string };
  headSha: string | null;
  status: 'queued' | 'analyzing' | 'building' | 'ready' | 'degraded' | 'failed';
  previewMode: 'iframe' | 'readme' | 'none';
  projectType: string | null;
  ecosystem: string | null;
  toolchain: Record<string, string> | null;
  error: string | null;
  stages: Stage[];
  diff: LockDiff | null;
  advisories: SecurityLens | null;
  story: Story | null;
  timeline: TimelinePoint[] | null;
  readmeMd: string | null;
  installSnippet: string | null;
  testLog: string | null;
  buildLog: string | null;
  buildMs: number | null;
  preview: { mode: string; active: boolean; url?: string; expiresAt?: number };
  sharePath: string;
  createdAt: string;
  updatedAt: string;
}
