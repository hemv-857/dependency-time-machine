import { ReleaseInfo } from '../types';

/** Minimal GitHub REST interface the resolver/pipeline depend on (mockable in tests). */
export interface GhClientLike {
  repo(fullName: string): Promise<GhRepo>;
  commitsUntil(fullName: string, iso: string): Promise<GhCommit[]>;
  latestCommit(fullName: string): Promise<GhCommit>;
  commit(fullName: string, ref: string): Promise<GhCommit>;
  releases(fullName: string): Promise<ReleaseInfo[]>;
}

export interface GhRepo {
  full_name: string;
  html_url: string;
  default_branch: string;
  created_at: string;
  private: boolean;
  description?: string;
  pushed_at?: string;
}

export interface GhCommit {
  sha: string;
  committedDate: string;
  message: string;
  htmlUrl?: string;
}

export class NotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'NotFoundError';
  }
}
export class RateLimitError extends Error {
  resetAt: string;
  constructor(msg: string, resetAt: string) {
    super(msg);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

/**
 * Resolve the commit a snapshot should pin to.
 * - explicit ref (tag/branch/sha) wins
 * - otherwise: last commit committed on/before the date on the default branch
 */
export async function resolveCommit(
  gh: GhClientLike,
  fullName: string,
  opts: { dateIso?: string; ref?: string }
): Promise<{ sha: string; committedDate: string; refUsed: string | null; repo: GhRepo }> {
  const repo = await gh.repo(fullName);
  if (repo.private) throw new Error('This repo is private — only public repos are supported in v1.');
  if (opts.ref) {
    const c = await gh.commit(fullName, opts.ref);
    return { sha: c.sha, committedDate: c.committedDate, refUsed: opts.ref, repo };
  }
  const dateIso = opts.dateIso || new Date().toISOString();
  const commits = await gh.commitsUntil(fullName, dateIso);
  if (commits.length === 0) {
    throw new Error(
      `No commits before ${dateIso.slice(0, 10)} — ${fullName}'s history starts ${repo.created_at.slice(0, 10)}. Pick a later date.`
    );
  }
  const c = commits[0];
  return { sha: c.sha, committedDate: c.committedDate, refUsed: null, repo };
}
