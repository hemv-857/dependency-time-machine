import { z } from 'zod';

export interface ParsedRepo {
  host: string;
  owner: string;
  name: string;
  /** owner/name */
  fullName: string;
  /** URL the user typed, normalized */
  canonical: string;
  /** date part of repo@date syntax, if present */
  date?: string;
}

/**
 * Accepts: github.com/o/r, https://github.com/o/r, https://github.com/o/r.git,
 * github.com/o/r@2024-01-15, github.com/o/r@v3.1.0, o/r
 * v1 supports public GitHub only.
 */
export function parseRepoInput(input: string): ParsedRepo {
  let s = (input || '').trim();
  if (!s) throw new Error('Enter a repository URL, e.g. github.com/expressjs/express');
  if (!/^https?:\/\//i.test(s) && !/^[^/]+\.[^/]+\//.test(s) && !/^[^/\s]+\/[^/\s]+$/.test(s)) {
    throw new Error('Not a repository URL');
  }
  s = s.replace(/^https?:\/\//i, '').replace(/\.git$/i, '');
  // trailing path parts (issues, tree/..., @date)
  let date: string | undefined;
  const at = s.indexOf('@');
  let pathPart = s;
  if (at !== -1 && !s.slice(at + 1).includes('/')) {
    date = s.slice(at + 1);
    pathPart = s.slice(0, at);
  }
  pathPart = pathPart.replace(/\/+$/, '');
  const parts = pathPart.split('/').filter(Boolean);
  if (parts[0].includes('.')) {
    const host = parts.shift()!.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') {
      throw new Error('Only github.com repos are supported in v1');
    }
  }
  if (parts.length < 2) throw new Error('Need owner and repo, e.g. github.com/expressjs/express');
  const owner = parts[0];
  const name = parts[1];
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) throw new Error('Invalid owner/repo');
  // '.' and '..' pass the charset check but are never valid GitHub owners/names;
  // reject them here rather than sending '../..' to the API.
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    throw new Error('Invalid owner/repo');
  }
  return {
    host: 'github.com',
    owner,
    name,
    fullName: `${owner}/${name}`,
    canonical: `github.com/${owner}/${name}`,
    date,
  };
}

export const dateOrRefSchema = z
  .string()
  .trim()
  .optional()
  .refine(
    (v) => !v || /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v) || /^v?\d+(\.\d+)*$/.test(v) || /^[\w./-]{1,80}$/.test(v),
    'Date should be YYYY-MM-DD (or a tag/branch)'
  );

/** Normalize a date-ish input to a UTC instant ISO string; tags pass through untouched. */
export function normalizeDateInput(v?: string): { kind: 'date'; iso: string } | { kind: 'ref'; ref: string } {
  if (!v) return { kind: 'date', iso: new Date(Date.now() - 365 * 86400_000).toISOString() };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return { kind: 'date', iso: new Date(`${v}T00:00:00.000Z`).toISOString() };
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return { kind: 'date', iso: d.toISOString() };
  return { kind: 'ref', ref: v };
}
