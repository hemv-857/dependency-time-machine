'use client';

import { Story } from '@/lib/tm-types';

const KIND_META: Record<Story['cards'][0]['kind'], { icon: string; ring: string }> = {
  major: { icon: '⬆️', ring: 'border-rose-500/30' },
  security: { icon: '🔐', ring: 'border-amber-500/30' },
  release: { icon: '🏷️', ring: 'border-edge' },
};

export default function StoryCards({ story, thenIso }: { story: Story; thenIso: string }) {
  return (
    <section className="mt-8">
      <h2 className="section-title">Story since then</h2>
      <p className="mb-4 text-slate-300">{story.headline}</p>
      {story.cards.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {story.cards.map((c) => {
            const meta = KIND_META[c.kind];
            return (
              <div key={c.id} className={`card border p-5 ${meta.ring}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-semibold text-slate-100">
                    <span className="mr-1.5">{meta.icon}</span>
                    {c.title}
                  </h3>
                  {c.date && <span className="mono shrink-0 text-[11px] text-slate-500">{c.date.slice(0, 10)}</span>}
                </div>
                <p className="mt-2 text-sm text-slate-400">{c.body}</p>
                {c.links.length > 0 && (
                  <p className="mt-3 flex flex-wrap gap-3 text-xs">
                    {c.links.map((l) => (
                      <a key={l.label + l.href} href={l.href} target="_blank" className="link">
                        {l.label} ↗
                      </a>
                    ))}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-slate-500">No notable releases between {thenIso.slice(0, 10)} and now.</p>
      )}
    </section>
  );
}
