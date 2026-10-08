import { LockDiff, ReleaseInfo, SecurityLens, Story, StoryCard } from '../types';

export interface NpmDocLite {
  repository?: { url?: string } | string;
  /** latest published version, from the registry /latest endpoint */
  ownVersion?: string;
  /** real release notes for this package's jump, filled in by the server */
  notes?: { summary: string; tag?: string; url?: string; date?: string } | null;
}

export function githubRepoFromNpmDoc(doc: NpmDocLite | null): string | null {
  const url = typeof doc?.repository === 'string' ? doc.repository : doc?.repository?.url;
  if (!url) return null;
  const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(\.git)?($|[/#])/i.exec(url);
  return m ? `${m[1]}` : null;
}

function excerpt(md: string, max = 220): string {
  const s = (md || '')
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function humanDate(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function linksForPackage(name: string, from: string, to: string, doc: NpmDocLite | null): { label: string; href: string }[] {
  const links = [
    { label: 'npm versions', href: `https://www.npmjs.com/package/${name}?activeTab=versions` },
    { label: 'diff', href: `https://npmdiff.dev/${name}/${from || '—'}/${name}/${to}` },
  ];
  const repo = githubRepoFromNpmDoc(doc);
  if (repo) links.splice(1, 0, { label: 'releases', href: `https://github.com/${repo}/releases` });
  return links;
}

/**
 * Turn raw pipeline outputs into the human story: a headline plus cards that
 * answer "what actually mattered since then".
 */
export function buildStory(opts: {
  repoFullName: string;
  repoUrl: string;
  thenIso: string;
  nowIso?: string;
  diff: LockDiff;
  lens: SecurityLens;
  releases: ReleaseInfo[];
  npmDocs: Record<string, NpmDocLite | null>;
  maxCards?: number;
}): Story {
  const { repoFullName, repoUrl, thenIso, diff, lens, releases, npmDocs } = opts;
  const thenLabel = humanDate(thenIso);
  const cards: StoryCard[] = [];

  const majors = diff.changes.filter((c) => c.kind === 'major').slice(0, 8);
  for (const c of majors) {
    const doc = npmDocs[c.name] || null;
    cards.push({
      id: `major-${c.name}`,
      kind: 'major',
      title: `${c.name} ${c.from || '∅'} → ${c.to}`,
      date: doc?.notes?.date,
      pkg: c.name,
      from: c.from,
      to: c.to,
      // prefer the package's own release notes; the generic sentence tells the
      // reader nothing the version number did not already imply
      body:
        doc?.notes?.summary ||
        'Major release. Check the release notes before upgrading — major bumps usually mean breaking changes.',
      links: linksForPackage(c.name, c.from || '—', c.to!, doc),
    });
  }

  if (lens.fixed.length > 0) {
    const worst = lens.fixed[0];
    cards.push({
      id: 'security-fixed',
      kind: 'security',
      title: `${lens.fixed.length} known vulnerabilit${lens.fixed.length === 1 ? 'y' : 'ies'} ${lens.fixed.length === 1 ? 'was' : 'were'} open back then — now fixed`,
      body: `Worst of them: ${worst.id}${worst.severity !== 'UNKNOWN' ? ` (${worst.severity})` : ''} in ${worst.packages.join(', ')} — ${worst.summary || 'no summary available'}. Upgrades since then patched these.`,
      links: [{ label: worst.id, href: worst.url }],
    });
  }
  if (lens.stillOpen.length > 0) {
    const worst = lens.stillOpen[0];
    cards.push({
      id: 'security-open',
      kind: 'security',
      title: `${lens.stillOpen.length} advisories still affect today's versions`,
      body: `${worst.id} in ${worst.packages.join(', ')} (${worst.severity}) — ${worst.summary || 'no summary available'}.`,
      links: [{ label: worst.id, href: worst.url }],
    });
  }

  const thenTs = Date.parse(thenIso);
  const repoReleases = releases
    .filter((r) => Date.parse(r.date) > thenTs)
    .slice(0, 5);
  for (const r of repoReleases) {
    cards.push({
      id: `release-${r.tag}`,
      kind: 'release',
      title: `${repoFullName} ${r.name || r.tag}`,
      date: r.date,
      body: excerpt(r.body) || 'No release notes.',
      links: [{ label: 'release notes', href: r.url }, { label: 'repo', href: repoUrl }],
    });
  }

  const parts: string[] = [];
  if (diff.counts.major) parts.push(`${diff.counts.major} major`);
  if (diff.counts.minor) parts.push(`${diff.counts.minor} minor`);
  if (diff.counts.patch) parts.push(`${diff.counts.patch} patch`);
  if (diff.counts.added) parts.push(`${diff.counts.added} added`);
  if (diff.counts.removed) parts.push(`${diff.counts.removed} removed`);
  const headline =
    `Since ${thenLabel}: ${parts.length ? parts.join(', ') : 'no dependency changes'} — ` +
    `${diff.counts.total} package${diff.counts.total === 1 ? '' : 's'} touched` +
    (lens.available ? `, ${lens.fixed.length} CVE${lens.fixed.length === 1 ? '' : 's'} fixed since` : '');
  return { headline, cards: cards.slice(0, opts.maxCards ?? 14) };
}
