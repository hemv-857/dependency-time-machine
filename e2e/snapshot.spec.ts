import { expect, test } from '@playwright/test';

test.describe('snapshot flow (hermetic: mocked GitHub/OSV/registry)', () => {
  test('paste URL + date → live snapshot with diff, story, security lens and iframe preview', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Any repo. Any date.');

    await page.getByLabel('Repository URL').fill('github.com/demo/demo');
    await page.getByLabel('Date').fill('2023-06-01');
    await page.getByRole('button', { name: 'Travel back' }).click();

    await page.waitForURL(/\/github\.com\/demo\/demo@2023-06-01/);
    await expect(page.getByText('resolving commit…', { exact: false })).toBeVisible({ timeout: 500 }).catch(() => {});

    // pipeline completes (analyze → diff → build → sandbox) and the page goes terminal
    await expect(page.locator('header, .card').first()).toBeVisible();
    await expect(page.getByText('left-pad').first()).toBeVisible({ timeout: 90_000 });

    // diff table: minor bump 1.0.0 → 1.3.0
    await expect(page.getByText('1.0.0').first()).toBeVisible();
    await expect(page.getByText('1.3.0').first()).toBeVisible();

    // story cards present (releases after the date + security)
    await expect(page.getByText('Story since then')).toBeVisible();
    await expect(page.getByText(/The Big One/)).toBeVisible();
    await expect(page.getByText(/now fixed/)).toBeVisible();

    // security lens shows the fixture advisory as fixed
    await expect(page.getByText('GHSA-demo-0001').first()).toBeVisible();

    // live preview iframe with the built fixture app
    const iframe = page.locator('iframe[title*="preview"]');
    await expect(iframe).toBeVisible({ timeout: 60_000 });
  });

  test('shareable path renders the snapshot directly', async ({ page }) => {
    await page.goto('/github.com/demo/demo@2023-06-01');
    await expect(page.getByText('left-pad').first()).toBeVisible({ timeout: 90_000 });
  });
});

test.describe('compare mode', () => {
  test('two dates side-by-side with delta table', async ({ page }) => {
    await page.goto('/compare?repo=github.com%2Fdemo%2Fdemo&a=2023-06-01&b=2024-06-01');
    await expect(page.getByText('2023-05-20').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('2024-08-01').first()).toBeVisible();
    await expect(page.getByText('left-pad').first()).toBeVisible();
    await expect(page.getByText('1.3.0').first()).toBeVisible();
  });
});

test.describe('API smoke', () => {
  test('health + full snapshot lifecycle via JSON API', async ({ request }) => {
    const health = await request.get('/api/healthz');
    expect(health.ok()).toBeTruthy();

    const created = await request.post('/api/snapshot', {
      data: { repo: 'github.com/demo/demo', date: '2023-06-01' },
    });
    expect(created.status()).toBe(202);
    const snap = await created.json();

    let state = snap;
    for (let i = 0; i < 120 && !['ready', 'degraded', 'failed'].includes(state.status); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      state = await (await request.get(`/api/snapshot/${snap.id}`)).json();
    }
    expect(state.status).toBe('ready');
    expect(state.diff.counts.total).toBeGreaterThan(0);
    expect(state.preview.mode).toBe('iframe');

    const preview = await request.post(`/api/snapshot/${snap.id}/preview`);
    expect(preview.ok()).toBeTruthy();
    const { url } = await preview.json();
    const page = await request.get(url);
    expect(await page.text()).toContain('Hello from the past');

    const log = await request.get(`/api/snapshot/${snap.id}/log`);
    expect(await log.text()).toContain('npm run build');
  });
});
