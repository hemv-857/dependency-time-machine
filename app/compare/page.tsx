import type { Metadata } from 'next';
import CompareView from '@/components/CompareView';

export const metadata: Metadata = { title: 'Compare two dates — Dependency Time Machine' };

// Next 15+ delivers searchParams as a Promise.
export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string; a?: string; b?: string }>;
}) {
  const sp = await searchParams;
  return (
    <div className="py-10">
      <h1 className="text-2xl font-bold text-slate-100">Compare mode</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-400">
        Pick two dates and see both snapshots side-by-side: the dependency set at each, and exactly what moved between them.
      </p>
      <CompareView initialRepo={sp.repo || ''} initialA={sp.a || ''} initialB={sp.b || ''} />
    </div>
  );
}
