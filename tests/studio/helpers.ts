import { type Page, expect } from '@playwright/test';

/**
 * Default service role key matching docker-compose.yml default.
 * Override via SERVICE_ROLE_KEY environment variable.
 */
export const SERVICE_ROLE_KEY =
  process.env.SERVICE_ROLE_KEY ||
  'dev-only-service-role-key-do-not-use-in-production';

/**
 * Log into pgStack Studio with the service role key.
 *
 * The login page has:
 *   - <input type="password" placeholder="sk_...">  (label "Service Role Key")
 *   - <button type="submit">Connect</button>
 *
 * After successful login the app navigates to /table-editor and shows the Shell
 * (Sidebar + TopBar + page content).
 */
export async function loginToStudio(page: Page): Promise<void> {
  await page.goto('/');
  const passwordInput = page.locator('input[type="password"]');
  const sidebar = page.locator('aside nav');

  // Race: already logged in (sidebar visible) vs needs login (password input visible)
  const result = await Promise.race([
    sidebar.waitFor({ state: 'visible', timeout: 5_000 }).then(() => 'authed' as const),
    passwordInput.waitFor({ state: 'visible', timeout: 5_000 }).then(() => 'login' as const),
  ]).catch(() => 'login' as const);

  if (result === 'authed') return;

  await passwordInput.fill(SERVICE_ROLE_KEY);
  // Click the "Connect" submit button
  await page.locator('button[type="submit"]').click();
  // Wait for the Shell sidebar to appear (proves auth succeeded)
  await sidebar.waitFor({ state: 'visible', timeout: 15_000 });
}

/**
 * Navigate to a specific section via the sidebar NavLink.
 * Sidebar nav items have labels: Table Editor, SQL Editor, Auth Users,
 * Database, Realtime, Logs.
 */
export async function navigateTo(
  page: Page,
  section: 'Table Editor' | 'SQL Editor' | 'Auth Users' | 'Database' | 'Realtime' | 'Logs',
): Promise<void> {
  const link = page.locator(`aside nav a`, { hasText: section });
  await link.click();
  // Wait for the TopBar title to reflect the selected section
  await expect(page.locator('header h1')).toContainText(section, { timeout: 10_000 });
}
