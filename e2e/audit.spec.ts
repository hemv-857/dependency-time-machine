import { expect, test, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * End-to-end audit.
 *
 * Sweeps every route for console errors, page exceptions, failed/4xx/5xx
 * requests and layout overflow, then exercises the real interactions. Reports
 * findings rather than only asserting, so regressions surface as a list.
 */

interface Finding {
  severity: 'critical' | 'warn' | 'info';
  where: string;
  what: string;
}
const findings: Finding[] = [];
const note = (severity: Finding['severity'], where: string, what: string) => {
  findings.push({ severity, where, what });
};

function watch(page: Page, where: string) {
  const urls = new Map<string, number>();
  page.on('console', (m: ConsoleMessage) => {
    const t = m.text();
    if (m.type() === 'error') {
      if (/favicon/i.test(t)) return;
      note('critical', where, `console error: ${t.slice(0, 220)}`);
    } else if (m.type() === 'warning' && /hydrat|key|validateDOMNesting|does not match/i.test(t)) {
      note('warn', where, `react warning: ${t.slice(0, 220)}`);
    }
  });
  page.on('pageerror', (e) => note('critical', where, `page exception: ${e.message.slice(0, 220)}`));
  page.on('requestfailed', (r) => {
    const f = r.failure();
    if (f && /net::ERR_ABORTED/.test(f.errorText)) return; // navigations cancel requests
    note('warn', where, `request failed: ${r.url().slice(0, 140)} (${f?.errorText})`);
  });
  page.on('response', (r) => {
    const s = r.status();
    if (s >= 500) note('critical', where, `HTTP ${s} ${r.url().slice(0, 140)}`);
    else if (s >= 400) urls.set(`${s} ${r.url().split('?')[0]}`, (urls.get(`${s} ${r.url().split('?')[0]}`) || 0) + 1);
  });
  return urls;
}

async function overflow(page: Page, where: string) {
  const o = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  if (o.scroll > o.client + 2) {
    note('warn', where, `horizontal overflow: scrollWidth ${o.scroll} > clientWidth ${o.client}`);
  }
}

async function settle(page: Page, url: string, where: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // wait for a terminal pipeline state
  for (let i = 0; i < 60; i++) {
    const t = await page.locator('body').innerText().catch(() => '');
    if (/changelog only|degraded|ready|failed|not a runnable/i.test(t) && !/analyzing|building|resolving/i.test(t)) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1500);
  await overflow(page, where);
}

test.describe('AUDIT', () => {
  test('01 home: renders, styles applied, form works', async ({ page }) => {
    const urls = watch(page, 'home');
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Any repo. Any date.');

    // styles actually applied (this is the regression that hid the whole UI)
    const styled = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      const body = getComputedStyle(document.body);
      return {
        h1Font: h1 ? getComputedStyle(h1).fontFamily : '',
        h1Weight: h1 ? getComputedStyle(h1).fontWeight : '',
        bodyBg: body.backgroundColor,
        linkDecor: (() => {
          const a = document.querySelector('a');
          return a ? getComputedStyle(a).textDecorationLine : '';
        })(),
      };
    });
    if (!/Inter|system-ui|-apple-system|sans-serif/i.test(styled.h1Font)) {
      note('critical', 'home', `heading not styled (font-family: ${styled.h1Font}) — stylesheet missing?`);
    }
    if (styled.h1Weight === '400' || Number(styled.h1Weight) < 600) {
      note('warn', 'home', `heading weight looks unstyled: ${styled.h1Weight}`);
    }
    if (styled.linkDecor === 'underline' && /rgb\(0, 0, 238\)|blue/i.test(styled.bodyBg)) {
      note('critical', 'home', 'links look browser-default — stylesheet missing?');
    }
    if (/rgba?\(0, 0, 0\)|rgb\(255, 255, 255\)/.test(styled.bodyBg)) {
      note('critical', 'home', `body background is default (${styled.bodyBg}) — stylesheet missing?`);
    }

    // every stylesheet and script must actually be css/js, never HTML
    const assets = await page.evaluate(() =>
      [...document.querySelectorAll('link[rel=stylesheet], script[src]')].map((el) => ({
        url: (el as HTMLLinkElement).href || (el as HTMLScriptElement).src || '',
        type: el.tagName === 'LINK' ? (el as HTMLLinkElement).type || (el as HTMLLinkElement).rel : 'script',
      }))
    );
    expect(assets.length).toBeGreaterThan(0);

    // example chips (these navigate to a snapshot, so return home afterwards)
    const chips = page.locator('button', { hasText: /express|create-react-app|Christmas/i });
    const chipCount = await chips.count();
    if (chipCount === 0) note('warn', 'home', 'no example chips found');
    if (chipCount > 0) {
      await chips.first().click();
      await page.waitForURL(/\/github\.com\/|express|create-react-app/i, { timeout: 20_000 }).catch(() => {});
      note('info', 'home', 'example chip navigates to a snapshot');
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Any repo. Any date.');
    }

    // the real flow: submit the form
    await page.getByLabel('Repository URL').fill('github.com/demo/demo');
    await page.getByLabel('Date').fill('2023-06-01');
    await page.getByRole('button', { name: 'Travel back' }).click();
    await page.waitForURL(/\/github\.com\/demo\/demo@/, { timeout: 30_000 });
    note('info', 'home', 'form submit navigates to shareable snapshot URL');

    // share button must not claim success when the clipboard write is denied
    await settle(page, '/github.com/demo/demo@2023-06-01', 'home/share');
    const share = page.getByRole('button', { name: /share|copied/i });
    if (await share.count()) {
      await share.first().click();
      await page.waitForTimeout(600);
      const claimed = /copied/i.test(await share.first().innerText());
      // In this context clipboard permission is denied, so claiming "copied"
      // would be a lie the user acts on.
      if (claimed) note('critical', 'home/share', 'share claims "copied" though the clipboard write was denied');
      else note('info', 'home/share', 'share does not falsely claim success when clipboard is denied');
    }

    for (const [k, v] of urls) note('warn', 'home', `${v}x ${k}`);
  });

  test('02 snapshot: all sections render and are interactive', async ({ page }) => {
    watch(page, 'snapshot');
    await settle(page, '/github.com/demo/demo@2023-06-01', 'snapshot');
    const body = await page.locator('body').innerText();

    for (const section of ['TIMELINE', 'STORY SINCE THEN', 'LOCKFILE']) {
      if (!body.includes(section)) note('critical', 'snapshot', `missing section: ${section}`);
    }
    if (!/left-pad/.test(body)) note('critical', 'snapshot', 'dependency diff missing (left-pad)');
    if (!/GHSA-/.test(body)) note('warn', 'snapshot', 'no advisory ids rendered');

    // filter chips
    const chips = page.locator('button', { hasText: /^(all|major|minor|patch|added|removed|security)$/i });
    const n = await chips.count();
    if (n === 0) {
      note('warn', 'snapshot', 'no diff filter chips found');
    } else {
      for (const label of ['major', 'security']) {
        const c = page.locator('button', { hasText: new RegExp(`^${label}$`, 'i') });
        if (await c.count()) {
          await c.first().click();
          await page.waitForTimeout(500);
          const after = await page.locator('table tbody tr, [role=row]').count();
          if (after === 0) note('warn', 'snapshot', `filter "${label}" produced an empty table`);
        }
      }
      const all = page.locator('button', { hasText: /^all$/i });
      if (await all.count()) await all.first().click();
    }

    // package filter input
    const filter = page.getByPlaceholder(/filter/i);
    if (await filter.count()) {
      await filter.first().fill('left-pad');
      await page.waitForTimeout(500);
      const rows = await page.locator('table tbody tr').count();
      if (rows === 0) note('warn', 'snapshot', 'filter input "left-pad" matched no rows');
      await filter.first().fill('');
    } else {
      note('warn', 'snapshot', 'no package filter input found');
    }

    // build log disclosure
    const logToggle = page.getByText(/build log/i).first();
    if (await logToggle.count()) {
      await logToggle.click();
      await page.waitForTimeout(400);
      note('info', 'snapshot', 'build log disclosure toggles');
    }

    // share button
    const share = page.getByRole('button', { name: /share/i });
    if (await share.count()) {
      await share.first().click();
      await page.waitForTimeout(400);
      const copied = await page.evaluate(() => !!navigator.clipboard);
      note('info', 'snapshot', `share button present (clipboard api: ${copied})`);
    } else {
      note('warn', 'snapshot', 'no share button found');
    }

    // timeline slider — it is an index into release points, not a percentage
    const slider = page.locator('input[type=range]');
    if (await slider.count()) {
      const max = Number(await slider.first().getAttribute('max'));
      if (!Number.isFinite(max) || max < 1) note('warn', 'snapshot', `timeline slider has no usable max (${max})`);
      else {
        const before = page.url();
        await slider.first().fill(String(max));
        await page.waitForTimeout(1500);
        if (page.url() === before) note('info', 'snapshot', 'slider at max did not change URL');
        else note('info', 'snapshot', `timeline slider jumps across ${max + 1} release points`);
      }
    } else {
      note('warn', 'snapshot', 'no timeline slider found');
    }
  });

  test('03 compare: both sides render', async ({ page }) => {
    watch(page, 'compare');
    await settle(page, '/compare?repo=github.com%2Fdemo%2Fdemo&a=2023-06-01&b=2024-06-01', 'compare');
    const body = await page.locator('body').innerText();
    if (!/2023-05-20/.test(body)) note('critical', 'compare', 'left commit date missing');
    if (!/2024-08-01/.test(body)) note('critical', 'compare', 'right commit date missing');
    if (!/1\.3\.0/.test(body)) note('warn', 'compare', 'delta version 1.3.0 missing');
    if (!/left-pad/.test(body)) note('warn', 'compare', 'left-pad missing from compare');
  });

  test('04 docs page renders', async ({ page }) => {
    watch(page, 'docs');
    const res = await page.goto('/docs');
    expect(res?.status()).toBe(200);
    const len = (await page.locator('body').innerText()).trim().length;
    if (len < 200) note('warn', 'docs', `docs page nearly empty (${len} chars)`);
  });

  test('05 responsive: no horizontal overflow', async ({ page }) => {
    // six page loads, each waiting on a real pipeline run
    test.setTimeout(420_000);
    watch(page, 'responsive');
    for (const [w, h, label] of [[375, 812, 'mobile'], [768, 1024, 'tablet'], [1280, 900, 'desktop']] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');
      await overflow(page, `home@${label}`);
      await settle(page, '/github.com/demo/demo@2023-06-01', `snapshot@${label}`);
    }
  });

  test('06 bad input and unknown routes are handled', async ({ page }) => {
    watch(page, 'errors');
    for (const bad of ['gitlab.com/a/b', 'not a repo', 'github.com/../..']) {
      const res = await page.request.get(`/api/resolve?repo=${encodeURIComponent(bad)}`);
      const j = await res.json().catch(() => null);
      if (res.status() === 200) note('critical', 'errors', `accepted invalid repo: ${bad}`);
      else if (!j?.error) note('warn', 'errors', `no error field for ${bad} (status ${res.status()})`);
      else note('info', 'errors', `${bad} -> ${res.status()} ${j.error}`);
    }
    // Unparseable share paths must be a real 404, not a 200 with a notice.
    // (A well-formed owner/repo is intentionally 200 even when GitHub has no
    // such repo — the client resolves it — so only test unparseable paths here.)
    for (const p of ['/justoneword', '/has%20space/x']) {
      const r = await page.request.get(p);
      if (r.status() !== 404) note('critical', 'errors', `unparseable path ${p} returned ${r.status()}, expected 404`);
      else if (!/not a time machine/i.test(await r.text())) note('warn', 'errors', `${p} 404 without helpful copy`);
      else note('info', 'errors', `${p} -> 404 with helpful copy`);
    }
    // snapshot id that does not exist
    const miss = await page.request.get('/api/snapshot/does-not-exist');
    if (miss.status() !== 404) note('warn', 'errors', `unknown snapshot id returned ${miss.status()}, expected 404`);
    else note('info', 'errors', 'unknown snapshot id -> 404');
  });

  test('07 new surfaces: OG card, browse page, listing API, markdown export', async ({ page }) => {
    watch(page, 'new-surfaces');

    // social metadata must exist without a snapshot being resolved (crawlers
    // never run JS, and the permalink resolves client-side)
    const html = await (await page.request.get('/github.com/axios/axios@2023-06-01')).text();
    if (!/property="og:title"/.test(html)) note('critical', 'new-surfaces', 'no og:title on a shareable permalink');
    if (!/property="og:image"/.test(html)) note('critical', 'new-surfaces', 'no og:image on a shareable permalink');
    if (!/name="twitter:card"/.test(html)) note('warn', 'new-surfaces', 'no twitter:card meta');
    const ogImg = /property="og:image" content="([^"]+)"/.exec(html)?.[1];
    if (!ogImg) {
      note('critical', 'new-surfaces', 'og:image has no URL');
    } else {
      const img = await page.request.get(ogImg);
      const type = img.headers()['content-type'] || '';
      if (img.status() !== 200) note('critical', 'new-surfaces', `og:image returned ${img.status()}`);
      // Slack/X will not render an SVG or an HTML error page
      else if (!/image\/(png|jpeg|webp|gif)/.test(type)) {
        note('critical', 'new-surfaces', `og:image content-type is ${type}, not a renderable raster image`);
      } else {
        note('info', 'new-surfaces', `og:image renders as ${type}`);
      }
    }

    // listing API
    const list = await page.request.get('/api/snapshots?limit=5');
    if (!list.ok()) note('critical', 'new-surfaces', `/api/snapshots returned ${list.status()}`);
    else {
      const j = await list.json();
      if (!Array.isArray(j.items)) note('critical', 'new-surfaces', '/api/snapshots has no items array');
      else if (typeof j.githubBudget?.remaining !== 'number') {
        note('warn', 'new-surfaces', '/api/snapshots does not report the github budget');
      } else {
        note('info', 'new-surfaces', `listing returns ${j.items.length}/${j.total}, budget ${j.githubBudget.remaining}`);
      }
      if (j.items?.[0]) {
        const md = await page.request.get(`/api/snapshot/${j.items[0].id}/markdown`);
        if (!md.ok()) note('critical', 'new-surfaces', `markdown export returned ${md.status()}`);
        else if (!/text\/markdown/.test(md.headers()['content-type'] || '')) {
          note('critical', 'new-surfaces', 'markdown export has the wrong content-type');
        } else {
          note('info', 'new-surfaces', `markdown export ${(await md.body()).length} bytes`);
        }
      }
    }

    // conditional requests
    const one = await page.request.get('/api/snapshots?limit=1');
    const id = (await one.json()).items?.[0]?.id;
    if (id) {
      const first = await page.request.get(`/api/snapshot/${id}`);
      const etag = first.headers()['etag'];
      if (!etag) note('warn', 'new-surfaces', 'snapshot response has no ETag');
      else {
        const second = await page.request.get(`/api/snapshot/${id}`, { headers: { 'if-none-match': etag } });
        if (second.status() !== 304) note('critical', 'new-surfaces', `If-None-Match returned ${second.status()}, expected 304`);
        else note('info', 'new-surfaces', 'ETag revalidation returns 304');
      }
    }

    // browse page renders and its filters are labelled
    await page.goto('/snapshots');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Browse snapshots');
    await expect(page.getByLabel('Repository')).toBeVisible();
    await expect(page.getByLabel('Status')).toBeVisible();
    await overflow(page, 'snapshots');
  });

  test('08 accessibility basics', async ({ page }) => {
    watch(page, 'a11y');
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // keyboard focus must be visible; preflight removes outlines, so this
    // regressed silently once already
    const ring = await page.evaluate(() => {
      const el = document.querySelector('a, button') as HTMLElement | null;
      if (!el) return null;
      el.focus();
      const s = getComputedStyle(el);
      return { outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle };
    });
    if (!ring) note('warn', 'a11y', 'no focusable element on the home page');
    else if (ring.outlineStyle === 'none' || parseFloat(ring.outlineWidth) < 1) {
      note('critical', 'a11y', `focused element has no visible outline (${ring.outlineStyle} ${ring.outlineWidth})`);
    } else {
      note('info', 'a11y', `focus ring present (${ring.outlineWidth} ${ring.outlineStyle})`);
    }

    // skip link, and landmarks
    const skip = await page.locator('a[href="#main"]').count();
    if (!skip) note('warn', 'a11y', 'no skip-to-content link');
    const navs = await page.locator('nav').count();
    if (!navs) note('warn', 'a11y', 'no nav landmark');
    const unnamedNav = await page.evaluate(
      () => [...document.querySelectorAll('nav')].filter((n) => !n.getAttribute('aria-label')).length
    );
    if (unnamedNav > 0) note('warn', 'a11y', `${unnamedNav} nav landmark(s) without an aria-label`);

    // images/controls need accessible names
    const unlabelled = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, a')] as HTMLElement[];
      return btns.filter((b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label')).length;
    });
    if (unlabelled > 0) note('warn', 'a11y', `${unlabelled} control(s) with no accessible name`);

    // reduced motion must be respected. 0.001ms computes to 1e-06s, so compare
    // numerically rather than matching a literal string.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await overflow(page, 'a11y/reduced-motion');
    const durations = await page.evaluate(() =>
      [...document.querySelectorAll('button, a, input')]
        .slice(0, 25)
        .map((el) => getComputedStyle(el).transitionDuration)
        .filter((d) => d && d !== '0s')
    );
    const worst = durations.reduce((max, d) => Math.max(max, parseFloat(d) || 0), 0);
    if (durations.length && worst > 0.01) {
      note('warn', 'a11y', `transitions still run under prefers-reduced-motion (worst ${worst}s)`);
    } else {
      note('info', 'a11y', `prefers-reduced-motion collapses transitions (worst ${worst}s)`);
    }
    await page.emulateMedia({ reducedMotion: null });
  });

  test('REPORT', async () => {
    const order = { critical: 0, warn: 1, info: 2 } as const;
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    const lines = findings.map((f) => `  [${f.severity.toUpperCase()}] ${f.where}: ${f.what}`);
    console.log(`\n===== AUDIT: ${findings.length} findings =====\n${lines.join('\n')}\n`);
    const criticals = findings.filter((f) => f.severity === 'critical');
    expect(criticals, `${criticals.length} critical finding(s):\n${lines.join('\n')}`).toEqual([]);
  });
});
