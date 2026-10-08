import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SnapshotView from '@/components/SnapshotView';

interface Props {
  params: { tm: string[] };
}

interface Parsed {
  owner: string;
  name: string;
  when?: string;
  ref?: string;
  label: string;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const parsed = parseSharePathSegments(params.tm);
  if (!parsed) return { title: 'Dependency Time Machine' };

  const label = parsed.when || parsed.ref || 'a past date';
  const title = `${parsed.owner}/${parsed.name} @ ${label} — Dependency Time Machine`;
  const description = `What shipped in ${parsed.owner}/${parsed.name} since ${label}: dependency bumps, lockfile then-vs-now diff, and which CVEs were open back then and are fixed now.`;

  // Crawlers fetch this without running JS, and the snapshot is resolved
  // client-side — so the card is built from the URL plus an indexed repo+date
  // lookup, with no GitHub call on the request path.
  const og = `/og/${encodeURIComponent(`${parsed.owner}/${parsed.name}`)}/${encodeURIComponent(label)}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      siteName: 'Dependency Time Machine',
      images: [{ url: og, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [og],
    },
  };
}

function parseSharePathSegments(segments: string[]): Parsed | null {
  const parts = [...segments].map(decodeURIComponent);
  if (parts[0] === 'github.com' || parts[0] === 'www.github.com') parts.shift();
  if (parts.length < 2) return null;
  const owner = parts[0];
  let name = parts[1];
  let when: string | undefined;
  let ref: string | undefined;
  const at = name.indexOf('@');
  if (at !== -1) {
    const tail = name.slice(at + 1);
    name = name.slice(0, at);
    if (/^\d{4}-\d{2}-\d{2}/.test(tail)) when = tail;
    else ref = tail;
  }
  name = name.replace(/\.git$/, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
  return { owner, name, when, ref, label: `${owner}/${name}${when || ref ? ` @ ${when || ref}` : ''}` };
}

export default function SharePage({ params }: Props) {
  const parsed = parseSharePathSegments(params.tm);
  // This catch-all matches every path, so a bad URL would otherwise render a
  // 200 "not a time machine URL" page. notFound() serves the same content from
  // app/not-found.tsx with a real 404 status.
  if (!parsed) notFound();
  return (
    <SnapshotView
      owner={parsed.owner}
      name={parsed.name}
      when={parsed.when}
      ref={parsed.ref}
      sharePath={`/${params.tm.map(encodeURIComponent).join('/')}`}
    />
  );
}