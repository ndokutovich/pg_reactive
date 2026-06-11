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
- Column headers show the column name (column types are shown in the insert/edit row form and the Database Browser)
- NULL values are shown as empty cells

## Filtering rows

Use the Filter button to add column filters:
- Each filter is a column + operator + value
- Operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `LIKE`, `ILIKE`, `IS` (same set for all column types)

Multiple filters are combined with AND.

## Editing a row

1. Click the pencil (Edit) icon in the row's **Actions** column
2. Modify the values in the modal form
3. Click **Save Changes**

Row edits execute an `UPDATE` statement using the primary key.

## Inserting a row

1. Click **Insert row**
2. Fill in the column values
3. Click **Insert**

Auto-increment (serial) columns are omitted from the form. Each field is labeled with its type, plus **PK** and **nullable** badges.

## Deleting rows

1. Click the trash icon in the row's **Actions** column
2. Confirm the browser dialog

Rows are deleted one at a time. Deletions are permanent — there is no undo.

## Schema information

The table editor itself has no schema view. To inspect a table's structure, open **Database** in the sidebar and select the table to see three tabs:
- **Columns** — name, type, nullable, default, primary key
- **Indexes** — index definitions
- **Foreign Keys** — references to other tables

The row count shown in the table editor header is an exact count of rows matching the current filters.

## Tips

**Large tables.** For tables with millions of rows, always apply a filter before browsing. Loading all rows without a limit will be slow.

**JSON/JSONB columns.** JSON values are displayed as formatted JSON in the editor. You can edit them directly.

**Array columns.** PostgreSQL array columns are displayed as JSON arrays (e.g., `["a","b","c"]`).
