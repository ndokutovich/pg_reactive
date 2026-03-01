import { test, expect } from '@playwright/test';
import { loginToStudio, navigateTo, SERVICE_ROLE_KEY } from './helpers';

// ---------------------------------------------------------------------------
// Login Page
// ---------------------------------------------------------------------------

test.describe('Login Page', () => {
  test('should show the login form with title and input', async ({ page }) => {
    await page.goto('/');
    // Title "pgStack Studio"
    await expect(page.locator('h1')).toHaveText('pgStack Studio', { timeout: 15_000 });
    // Subtitle prompting for service role key
    await expect(page.locator('text=Enter your Service Role Key to connect')).toBeVisible();
    // Password input with placeholder
    const input = page.locator('input[type="password"]');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', 'sk_...');
    // Connect button
    await expect(page.locator('button[type="submit"]')).toHaveText(/Connect/);
  });

  test('should show validation error for empty key', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('input[type="password"]');
    await input.waitFor({ state: 'visible', timeout: 15_000 });
    // Submit with empty input
    await page.locator('button[type="submit"]').click();
    // The form validates: "Service role key is required"
    await expect(page.locator('text=Service role key is required')).toBeVisible({ timeout: 5_000 });
  });

  test('should show error for invalid key', async ({ page }) => {
    await page.goto('/');
    const input = page.locator('input[type="password"]');
    await input.waitFor({ state: 'visible', timeout: 15_000 });
    await input.fill('totally-invalid-key-12345');
    await page.locator('button[type="submit"]').click();
    // API call to /api/catalog/refresh will fail with the wrong key
    await expect(page.locator('text=Invalid key or server unreachable')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('should login successfully with valid service role key', async ({ page }) => {
    await loginToStudio(page);
    // After login the sidebar should be visible with nav items
    await expect(page.locator('aside nav a', { hasText: 'Table Editor' })).toBeVisible();
    await expect(page.locator('aside nav a', { hasText: 'SQL Editor' })).toBeVisible();
    await expect(page.locator('aside nav a', { hasText: 'Auth Users' })).toBeVisible();
    await expect(page.locator('aside nav a', { hasText: 'Database' })).toBeVisible();
    await expect(page.locator('aside nav a', { hasText: 'Realtime' })).toBeVisible();
    await expect(page.locator('aside nav a', { hasText: 'Logs' })).toBeVisible();
    // TopBar shows "Table Editor" (default route redirect)
    await expect(page.locator('header h1')).toHaveText('Table Editor');
    // Logout button present
    await expect(page.locator('button', { hasText: 'Logout' })).toBeVisible();
  });

  test('should redirect unauthenticated access to login', async ({ page }) => {
    // Attempt to go directly to /table-editor without logging in
    await page.goto('/table-editor');
    // AuthGuard should redirect to /login
    await expect(page.locator('h1')).toHaveText('pgStack Studio', { timeout: 15_000 });
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Shell Layout (Sidebar, TopBar, Logout)
// ---------------------------------------------------------------------------

test.describe('Shell Layout', () => {
  test.beforeEach(async ({ page }) => {
    await loginToStudio(page);
  });

  test('should show the pgStack branding in sidebar', async ({ page }) => {
    // The sidebar header shows "pgStack" and "Studio"
    await expect(page.locator('aside p', { hasText: 'pgStack' })).toBeVisible();
    await expect(page.locator('aside p', { hasText: 'Studio' })).toBeVisible();
  });

  test('should highlight active nav item', async ({ page }) => {
    // After login, Table Editor is the default route
    const activeLink = page.locator('aside nav a', { hasText: 'Table Editor' });
    // The active NavLink has border-brand class (CSS active style)
    await expect(activeLink).toHaveClass(/text-brand/);
  });

  test('should have a theme toggle button', async ({ page }) => {
    const toggle = page.locator('button[aria-label="Toggle theme"]');
    await expect(toggle).toBeVisible();
    // Clicking it should not break the page
    await toggle.click();
    await expect(page.locator('aside nav')).toBeVisible();
  });

  test('should logout and return to login page', async ({ page }) => {
    await page.locator('button', { hasText: 'Logout' }).click();
    // After logout, should see the login page again
    await expect(page.locator('h1')).toHaveText('pgStack Studio', { timeout: 10_000 });
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Table Editor
// ---------------------------------------------------------------------------

test.describe('Table Editor', () => {
  test.beforeEach(async ({ page }) => {
    await loginToStudio(page);
    await navigateTo(page, 'Table Editor');
  });

  test('should show table list grouped by schema', async ({ page }) => {
    // The TableList shows schema names as collapsible headers (uppercase text)
    // Wait for at least one schema group to appear (e.g. "public", "pgr", etc.)
    await expect(
      page.locator('button', { hasText: /^(PUBLIC|public|pgr|PGR|pgstack|PGSTACK)$/ }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test('should show placeholder text when no table is selected', async ({ page }) => {
    // The TableGrid shows a placeholder when no table is selected
    await expect(
      page.locator('text=Select a table from the sidebar to get started')
    ).toBeVisible({ timeout: 10_000 });
  });

  test('should display table data when a table is clicked', async ({ page }) => {
    // Click the first table name (the button with TableIcon inside the schema group)
    const firstTable = page.locator(
      'main button:has(svg) span.truncate'
    ).first();
    await firstTable.waitFor({ state: 'visible', timeout: 15_000 });
    const tableName = await firstTable.textContent();
    await firstTable.click();
    // After clicking, the grid header should show schema.table
    if (tableName) {
      await expect(page.locator(`text=${tableName}`)).toBeVisible({ timeout: 10_000 });
    }
    // The DataGrid should render a <table> element
    await expect(page.locator('main table')).toBeVisible({ timeout: 10_000 });
    // Column headers (th elements) should be present
    const headers = page.locator('main table thead th');
    await expect(headers.first()).toBeVisible({ timeout: 10_000 });
  });

  test('should show row count and pagination for loaded table', async ({ page }) => {
    // Click a table to load data
    const firstTable = page.locator('main button:has(svg) span.truncate').first();
    await firstTable.waitFor({ state: 'visible', timeout: 10_000 });
    await firstTable.click();
    // Wait for the DataGrid to render
    await page.locator('main table').waitFor({ state: 'visible', timeout: 10_000 });
    // Look for row count indicator ("N rows" text in the grid header)
    await expect(page.locator('text=/\\d+ rows/')).toBeVisible({ timeout: 10_000 });
  });

  test('should have filter, refresh, and insert row buttons', async ({ page }) => {
    // Click a table first
    const firstTable = page.locator('main button:has(svg) span.truncate').first();
    await firstTable.waitFor({ state: 'visible', timeout: 10_000 });
    await firstTable.click();
    await page.locator('main table').waitFor({ state: 'visible', timeout: 10_000 });
    // Toolbar buttons
    await expect(page.locator('button', { hasText: 'Filter' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Refresh' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Insert Row' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// SQL Editor
// ---------------------------------------------------------------------------

test.describe('SQL Editor', () => {
  test.beforeEach(async ({ page }) => {
    await loginToStudio(page);
    await navigateTo(page, 'SQL Editor');
  });

  test('should show the SQL editor page with CodeMirror editor', async ({ page }) => {
    // The SQL editor uses CodeMirror; it renders a .cm-editor div
    await expect(page.locator('.cm-editor')).toBeVisible({ timeout: 10_000 });
    // The Run button should be visible in the EditorToolbar
    await expect(page.locator('button', { hasText: 'Run' })).toBeVisible();
    // Default SQL content should be visible in the editor
    await expect(page.locator('.cm-content')).toBeVisible();
  });

  test('should show history toggle button', async ({ page }) => {
    // The "Hide History" / "Show History" toggle
    await expect(
      page.locator('button[aria-label="Toggle history panel"]')
    ).toBeVisible({ timeout: 10_000 });
  });

  test('should execute a query and show results', async ({ page }) => {
    // The editor loads with a default query. Clear and type our own.
    const cmContent = page.locator('.cm-content');
    await cmContent.click();
    // Select all existing text and replace
    await page.keyboard.press('Control+a');
    await page.keyboard.type('SELECT 42 AS answer');
    // Click the Run button
    await page.locator('button', { hasText: 'Run' }).click();
    // Wait for results to appear
    // The ResultsGrid should show a table with "answer" header and "42" value
    await expect(page.locator('th', { hasText: 'answer' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('td', { hasText: '42' })).toBeVisible({ timeout: 5_000 });
    // Row count indicator
    await expect(page.locator('text=/\\d+ rows?/')).toBeVisible({ timeout: 5_000 });
  });

  test('should run a query with Ctrl+Enter', async ({ page }) => {
    const cmContent = page.locator('.cm-content');
    await cmContent.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type("SELECT 'hello' AS greeting");
    // Use keyboard shortcut instead of button
    await page.keyboard.press('Control+Enter');
    // Results should appear
    await expect(page.locator('th', { hasText: 'greeting' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('td', { hasText: 'hello' })).toBeVisible({ timeout: 5_000 });
  });

  test('should show error for invalid SQL', async ({ page }) => {
    const cmContent = page.locator('.cm-content');
    await cmContent.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('SELECT FROM WHERE INVALID');
    await page.locator('button', { hasText: 'Run' }).click();
    // The ResultsGrid error display shows "Query Error" heading
    await expect(page.locator('text=Query Error')).toBeVisible({ timeout: 10_000 });
  });

  test('should show elapsed time after query execution', async ({ page }) => {
    const cmContent = page.locator('.cm-content');
    await cmContent.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('SELECT 1');
    await page.locator('button', { hasText: 'Run' }).click();
    // The toolbar shows "Nms" elapsed time indicator
    await expect(page.locator('text=/\\d+ms/')).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Auth Users
// ---------------------------------------------------------------------------

test.describe('Auth Users', () => {
  test.beforeEach(async ({ page }) => {
    await loginToStudio(page);
    await navigateTo(page, 'Auth Users');
  });

  test('should show the users page with header and new user button', async ({ page }) => {
    // Page header "Users"
    await expect(page.locator('h2', { hasText: 'Users' })).toBeVisible({ timeout: 10_000 });
    // "New User" button
    await expect(page.locator('button', { hasText: 'New User' })).toBeVisible();
  });

  test('should show user table with column headers', async ({ page }) => {
    // Wait for the UserTable DataGrid to render
    await page.locator('table').waitFor({ state: 'visible', timeout: 15_000 });
    // Column headers from UserTable: Email, Role, Confirmed, Created
    await expect(page.locator('th', { hasText: 'Email' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Role' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Confirmed' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Created' })).toBeVisible();
  });

  test('should open create user modal', async ({ page }) => {
    await page.locator('button', { hasText: 'New User' }).click();
    // The CreateUserModal should appear -- look for a modal/overlay or form elements
    // Modal typically renders with a backdrop or form with email/password fields
    await expect(
      page.locator('input[type="email"], input[placeholder*="email" i], label:has-text("Email")')
        .first()
    ).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Database Browser
// ---------------------------------------------------------------------------

test.describe('Database Browser', () => {
  test.beforeEach(async ({ page }) => {
    await loginToStudio(page);
    await navigateTo(page, 'Database');
  });

  test('should show the schema browser heading', async ({ page }) => {
    await expect(page.locator('text=Schema Browser')).toBeVisible({ timeout: 10_000 });
  });

  test('should show placeholder when no table is selected', async ({ page }) => {
    await expect(
      page.locator('text=Select a table to inspect its structure')
    ).toBeVisible({ timeout: 10_000 });
  });

  test('should list schemas with table counts', async ({ page }) => {
    // Schema groups shown as buttons with schema name and count
    const schemaButton = page.locator('button', {
      hasText: /^(PUBLIC|public|pgr|PGR|pgstack|PGSTACK)$/,
    }).first();
    await expect(schemaButton).toBeVisible({ timeout: 15_000 });
    // The count badge next to schema name
    await expect(schemaButton.locator('span').last()).toBeVisible();
  });

  test('should show table detail when a table is clicked', async ({ page }) => {
    // Wait for schema tree to load
    const firstTable = page.locator(
      'main button:has(svg) span.truncate'
    ).first();
    await firstTable.waitFor({ state: 'visible', timeout: 15_000 });
    await firstTable.click();
    // The TableDetail component should render. It typically shows column list,
    // index list, and FK list. Wait for any of those to appear.
    await expect(
      page.locator('text=/Columns|Indexes|Foreign Keys|column_name|data_type/i').first()
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Realtime Monitor
// ---------------------------------------------------------------------------

test.describe('Realtime Monitor', () => {
  test.beforeEach(async ({ page }) => {
    await loginToStudio(page);
    await navigateTo(page, 'Realtime');
  });

  test('should show active subscriptions heading', async ({ page }) => {
    await expect(
      page.locator('h3', { hasText: 'Active Subscriptions' })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('should show subscription count widget', async ({ page }) => {
    // ClientCount component shows a large number and "active subscriptions" label
    await expect(page.locator('text=active subscriptions')).toBeVisible({ timeout: 10_000 });
    // The refresh interval note
    await expect(page.locator('text=refreshes every 5 seconds')).toBeVisible();
  });

  test('should show subscription table with column headers', async ({ page }) => {
    // SubscriptionTable has columns: Query ID, Query, Invalidations
    await page.locator('table').waitFor({ state: 'visible', timeout: 15_000 });
    await expect(page.locator('th', { hasText: 'Query ID' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Query' })).toBeVisible();
    await expect(page.locator('th', { hasText: 'Invalidations' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Logs (Active Queries)
// ---------------------------------------------------------------------------

test.describe('Logs Page', () => {
  test.beforeEach(async ({ page }) => {
    await loginToStudio(page);
    await navigateTo(page, 'Logs');
  });

  test('should show the active queries heading', async ({ page }) => {
    await expect(page.locator('h2', { hasText: 'Active Queries' })).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('text=Live view of non-idle PostgreSQL queries')
    ).toBeVisible();
  });

  test('should render the log viewer area', async ({ page }) => {
    // LogViewer has aria-label="Active PostgreSQL queries"
    const logViewer = page.locator('[aria-label="Active PostgreSQL queries"]');
    await expect(logViewer).toBeVisible({ timeout: 10_000 });
    // It uses a monospace font class
    await expect(logViewer).toHaveClass(/font-mono/);
  });

  test('should show log lines after auto-refresh', async ({ page }) => {
    // The LogViewer polls every 3 seconds. Wait for at least one refresh cycle.
    const logViewer = page.locator('[aria-label="Active PostgreSQL queries"]');
    await expect(logViewer).toBeVisible({ timeout: 10_000 });
    // Wait for log lines to appear (either actual queries or "No active queries" message)
    await expect(
      logViewer.locator('div').first()
    ).toBeVisible({ timeout: 10_000 });
    // After a refresh, there should be timestamp separator lines (--- HH:MM:SS ---)
    await expect(
      logViewer.locator('div', { hasText: /^---.*---$/ }).first()
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Navigation Between Sections
// ---------------------------------------------------------------------------

test.describe('Cross-section Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await loginToStudio(page);
  });

  test('should navigate between all sections without errors', async ({ page }) => {
    // Visit each section and verify the TopBar title updates
    await navigateTo(page, 'SQL Editor');
    await expect(page.locator('header h1')).toHaveText('SQL Editor');

    await navigateTo(page, 'Auth Users');
    await expect(page.locator('header h1')).toHaveText('Auth Users');

    await navigateTo(page, 'Database');
    await expect(page.locator('header h1')).toHaveText('Database');

    await navigateTo(page, 'Realtime');
    await expect(page.locator('header h1')).toHaveText('Realtime');

    await navigateTo(page, 'Logs');
    await expect(page.locator('header h1')).toHaveText('Logs');

    await navigateTo(page, 'Table Editor');
    await expect(page.locator('header h1')).toHaveText('Table Editor');
  });

  test('should persist login across page reloads', async ({ page }) => {
    // The auth store uses zustand persist with localStorage.
    // After reload the key should be restored and auth should hold.
    await page.reload();
    // Should still see the sidebar (not redirected to login)
    await expect(page.locator('aside nav')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('header h1')).toBeVisible();
  });
});
