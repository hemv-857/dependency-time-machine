import { LockDiff, PkgChange, SecurityLens, Story, TimelinePoint } from '@/core/types';
import { SnapshotRow } from '@/server/store';

/**
 * Render a snapshot as a standalone Markdown report.
 *
 * The value of this tool is the permalink, so the export has to stand on its own
 * in a PR description or an incident doc: commit pinned and linked, what changed,
 * which CVEs were open then, and the caveat that the build may not have run.
 */

const KIND_LABEL: Record<PkgChange['kind'], string> = {
  major: 'major', minor: 'minor', patch: 'patch',
  added: 'added', removed: 'removed', changed: 'changed',
};

/** Strip characters that would break out of a Markdown table cell. */
function cell(s: string): string {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function day(iso?: string | null): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
}

export function snapshotToMarkdown(row: SnapshotRow, origin = ''): string {
  const out: string[] = [];
  // matches the shareable route in app/[...tm]: /github.com/owner/name@DATE
  const permalink = origin
    ? `${origin.replace(/\/$/, '')}/github.com/${row.repo}${row.dateIso ? `@${row.dateIso.slice(0, 10)}` : ''}`
    : '';

  out.push(`# ${row.repo}${row.dateIso ? ` @ ${day(row.dateIso)}` : ''}`, '');
  out.push(
    `Pinned to [\`${row.commitSha.slice(0, 10)}\`](https://github.com/${row.repo}/commit/${row.commitSha})` +
      ` (committed ${day(row.commitDate)}).`
  );
  if (row.projectType || row.ecosystem) {
    out.push('', `Detected **${row.projectType || 'unknown'}** project · \`${row.ecosystem || 'n/a'}\` ecosystem.`);
  }
  if (permalink) out.push('', `Permalink: ${permalink}`);
  out.push('');

  // ---- status / caveat
  if (row.status === 'degraded' || row.status === 'failed') {
    out.push('> [!WARNING]');
    out.push(`> This snapshot is \`${row.status}\`${row.error ? `: ${row.error}` : ''}.`);
    out.push('> The analysis below is still valid; the build/preview may be missing.');
    out.push('');
  }

  const diff = row.diff as LockDiff | null;
  if (diff && diff.changes.length) {
    const c = diff.counts;
    out.push('## Dependency changes since then', '');
    out.push(
      `**${c.total}** packages touched — ${c.major} major, ${c.minor} minor, ${c.patch} patch, ` +
        `${c.added} added, ${c.removed} removed.`,
      ''
    );

    // security-affected packages first: they are the reason to read this report
    const withAdvisories = diff.changes.filter((ch) => (ch.advisories || []).length);
    const rest = diff.changes.filter((ch) => !(ch.advisories || []).length);
    const listed = [...withAdvisories, ...rest].slice(0, 200);

    out.push('| Package | Then | Now | Change | Advisories |', '|---|---|---|---|---|');
    for (const ch of listed) {
      const adv = (ch.advisories || []).map((a) => `[${a.id}](${a.url})`).join(', ');
      out.push(
        `| \`${cell(ch.name)}\` | ${cell(ch.from || '—')} | ${cell(ch.to || '—')} | ${KIND_LABEL[ch.kind] || ch.kind} | ${adv} |`
      );
    }
    if (diff.changes.length > listed.length) {
      out.push('', `_…and ${diff.changes.length - listed.length} more packages not shown._`);
    }
    out.push('');
  } else if (row.ecosystem) {
    out.push('## Dependency changes since then', '', `No lockfile diff available${row.ecosystem === 'npm' ? ' (this repo commits no lockfile)' : ''}.`, '');
  }

  // ---- security
  const lens = row.advisories as SecurityLens | null;
  if (lens && lens.available) {
    out.push('## Security', '');
    if (lens.then.length === 0) {
      out.push(`No known advisories affected the versions in this snapshot.`, '');
    } else {
      out.push(
        `**${lens.then.length}** advisories affected these versions back then — ` +
          `**${lens.fixed.length}** are fixed by what ships now, **${lens.stillOpen.length}** still open.`,
        ''
      );
      const section = (title: string, items: typeof lens.fixed) => {
        if (!items.length) return;
        out.push(`### ${title} (${items.length})`, '');
        for (const a of items.slice(0, 100)) {
          const sev = a.severity && a.severity !== 'UNKNOWN' ? `**${a.severity}** — ` : '';
          const pkgs = a.packages.map((p) => `\`${p}\``).join(', ');
          const summary = a.summary ? ` ${a.summary}` : '';
          out.push(`- ${sev}[${a.id}](${a.url}) in ${pkgs}.${summary}`);
        }
        out.push('');
      };
      section('Fixed since', lens.fixed);
      section('Still open', lens.stillOpen);
    }
  } else {
    out.push('## Security', '', '_Advisory data unavailable for this snapshot._', '');
  }

  // ---- story
  const story = row.story as Story | null;
  if (story && story.cards.length) {
    out.push('## Changelog', '', story.headline, '');
    for (const card of story.cards) {
      const when = card.date ? ` _(${day(card.date)})_` : '';
      out.push(`### ${card.title}${when}`, '', card.body, '');
      if (card.links?.length) out.push(card.links.map((l) => `[${l.label}](${l.href})`).join(' · '), '');
    }
  }

  // ---- releases timeline
  const timeline = row.timeline as TimelinePoint[] | null;
  if (timeline && timeline.length > 1) {
    out.push('## Release timeline', '');
    for (const p of timeline.slice(0, 100)) {
      const label = p.href ? `[${cell(p.label)}](${p.href})` : cell(p.label);
      out.push(`- ${day(p.date)} — ${label}`);
    }
    out.push('');
  }

  if (row.installSnippet) {
    out.push('## Install', '', '```sh', row.installSnippet, '```', '');
  }

  out.push('---', '', `<sub>Generated by Dependency Time Machine${row.buildMs ? ` · build ${Math.round(row.buildMs / 1000)}s` : ''}</sub>`);
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}