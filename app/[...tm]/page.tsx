import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SnapshotView from '@/components/SnapshotView';

interface Props {
  params: { tm: string[] };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const title = parseSharePathSegments(params.tm)?.label || 'Dependency Time Machine';
  return { title };
}

function parseSharePathSegments(segments: string[]): { owner: string; name: string; when?: string; label: string } | null {
  const parts = [...segments].map(decodeURIComponent);
  if (parts[0] === 'github.com' || parts[0] === 'www.github.com') parts.shift();
  if (parts.length < 2) return null;
  const owner = parts[0];
  let name = parts[1];
  let when: string | undefined;
  const at = name.indexOf('@');
  if (at !== -1) {
    when = name.slice(at + 1);
    name = name.slice(0, at);
  }
  name = name.replace(/\.git$/, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
  return { owner, name, when, label: `${owner}/${name}${when ? ` @ ${when}` : ''}` };
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
      sharePath={`/${params.tm.map(encodeURIComponent).join('/')}`}
    />
  );
}
