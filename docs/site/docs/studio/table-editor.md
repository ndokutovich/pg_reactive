---
title: Table Editor
sidebar_position: 2
description: Browse, query, and edit database table data in pgStack Studio.
---

# Table Editor

The Table Editor lets you browse and modify your PostgreSQL tables through a visual interface.

## Navigating to a table

1. Open Studio at [http://127.0.0.1:8080/studio/](http://127.0.0.1:8080/studio/)
2. Select the schema from the left sidebar (usually `public`)
3. Click on a table name to open it

## Browsing data

The table editor shows rows in a paginated grid:
- 50 rows per page by default
- Column headers show the column name and type
- NULL values are shown as `NULL` (grayed out)
- Click column headers to sort ascending/descending

## Filtering rows

Use the Filter button to add column filters:
- Text columns: contains, equals, starts with, ends with
- Numeric columns: equals, greater than, less than
- Boolean columns: is true, is false
- Date columns: before, after, on

Multiple filters are combined with AND.

## Editing a row

1. Click a row to select it
2. Click **Edit** or double-click a cell to enter edit mode
3. Modify the values
4. Click **Save** or press Enter to commit

Row edits execute an `UPDATE` statement using the primary key.

## Inserting a row

1. Click **Insert row**
2. Fill in the column values
3. Click **Save**

The editor shows default values for columns that have them. Required columns (NOT NULL without default) are highlighted.

## Deleting rows

1. Select one or more rows using the checkboxes
2. Click **Delete selected**
3. Confirm the deletion

Deletions are permanent — there is no undo.

## Exporting data

Click **Export** to download the current table data:
- **CSV** — comma-separated values
- **JSON** — array of row objects

The export respects any active filters.

## Schema information

Click the **Schema** tab at the top of the table editor to see:
- Column names, types, and constraints
- Primary key definition
- Foreign key references
- Indexes
- Row count estimate

## Tips

**Large tables.** For tables with millions of rows, always apply a filter before browsing. Loading all rows without a limit will be slow.

**JSON/JSONB columns.** JSON values are displayed as formatted JSON in the editor. You can edit them directly.

**Array columns.** PostgreSQL array columns are displayed as JSON arrays (e.g., `["a","b","c"]`).
