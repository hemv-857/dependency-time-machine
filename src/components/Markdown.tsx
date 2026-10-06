'use client';

import { useMemo } from 'react';

/**
 * Tiny escape-first markdown renderer for README previews.
 * Escapes all HTML, then applies a conservative subset of markdown — so repo
 * content can never inject markup into our origin.
 */
export default function Markdown({ md }: { md: string }) {
  const html = useMemo(() => render(md || ''), [md]);
  return <div className="prose-invert space-y-3 text-sm leading-relaxed text-slate-300" dangerouslySetInnerHTML={{ __html: html }} />;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code class="rounded bg-black/50 px-1 py-0.5 font-mono text-[12px] text-mint">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_m, text, href) => `<a class="link" href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
    );
}

function render(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];
  let listBuf: string[] = [];

  const flushList = () => {
    if (listBuf.length) {
      out.push(`<ul class="list-disc space-y-1 pl-5">${listBuf.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
      listBuf = [];
    }
  };

  for (const line of lines) {
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      if (inCode) {
        out.push(
          `<pre class="log-box"><code>${esc(codeBuf.join('\n'))}</code></pre>`
        );
        codeBuf = [];
        inCode = false;
        codeLang = '';
      } else {
        flushList();
        inCode = true;
        codeLang = fence[1];
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const level = h[1].length;
      const cls = ['text-2xl font-bold text-slate-100', 'text-xl font-bold text-slate-100', 'text-lg font-semibold text-slate-200', 'text-base font-semibold text-slate-200'][level - 1];
      out.push(`<h${level} class="${cls} mt-4 mb-1">${inline(h[2])}</h${level}>`);
      continue;
    }
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li) {
      listBuf.push(li[1]);
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushList();
      continue;
    }
    if (/^(---+|\*\*\*+)\s*$/.test(line)) {
      flushList();
      out.push('<hr class="border-edge/60" />');
      continue;
    }
    flushList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode && codeBuf.length) out.push(`<pre class="log-box"><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  flushList();
  return out.join('\n');
}
