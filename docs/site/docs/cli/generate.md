---
title: pgstack generate
sidebar_position: 5
description: Generate TypeScript types from your PostgreSQL schema.
---

# pgstack generate

Generate TypeScript type definitions from your PostgreSQL schema. Types are inferred from `pg_catalog` — columns, types, constraints, and nullability — so they stay in sync with your database.

## Usage

```bash
# Print to stdout
pgstack generate types

# Write to a file
pgstack generate types --output src/types/database.ts

# Specify a different database URL
pgstack generate types --db-url postgres://user:pass@host:5432/dbname
```

## Output format

The generator produces a `Database` type with a nested structure per schema and table:

```typescript
export interface Database {
  public: {
    Tables: {
      todos: {
        Row: {
          id: number;
          user_id: string | null;
          title: string;
          done: boolean;
          created_at: string;
        };
        Insert: {
          id?: number;
          user_id?: string | null;
          title: string;
          done?: boolean;
          created_at?: string;
        };
        Update: {
          id?: number;
          user_id?: string | null;
          title?: string;
          done?: boolean;
          created_at?: string;
        };
      };
      orders: {
        Row: {
          id: number;
          user_id: string;
          status: string;
          amount: string;
          created_at: string;
        };
        // ... Insert, Update
      };
    };
    Views: {
      // ... views
    };
    Functions: {
      // ... functions
    };
  };
}
```

## Using generated types with the SDK

```typescript
import type { Database } from './types/database';
import { createClient } from '@pgstack/sdk';

const pgstack = createClient<Database>('http://127.0.0.1:8080', 'your-anon-key');

// Typed query — data is Todo[] | null
type Todo = Database['public']['Tables']['todos']['Row'];
const { data } = await pgstack.from<Todo>('todos').select('*');

// data[0].id is number
// data[0].title is string
// data[0].done is boolean

// Typed insert
type TodoInsert = Database['public']['Tables']['todos']['Insert'];
const newTodo: TodoInsert = {
  title: 'Buy groceries',  // required
  done: false,              // optional (has default)
  // id and created_at are optional (auto-generated)
};

await pgstack.from('todos').insert(newTodo);
```

## PostgreSQL to TypeScript type mapping

| PostgreSQL type | TypeScript type |
|----------------|----------------|
| `integer`, `bigint`, `smallint` | `number` |
| `numeric`, `decimal`, `real`, `double precision` | `string` (preserves precision) |
| `text`, `varchar`, `char`, `citext` | `string` |
| `boolean` | `boolean` |
| `uuid` | `string` |
| `json`, `jsonb` | `unknown` |
| `timestamp`, `timestamptz` | `string` (ISO 8601) |
| `date` | `string` (YYYY-MM-DD) |
| `time`, `timetz` | `string` |
| `bytea` | `string` (base64) |
| `text[]`, `integer[]` | `string[]`, `number[]` |
| `ENUM` | union of string literals |

## Nullable columns

Columns that allow NULL are typed as `T | null`. Columns with NOT NULL constraints are non-nullable:

```typescript
// NOT NULL column
title: string;

// nullable column (no NOT NULL constraint)
description: string | null;
```

## Keeping types in sync

Add type generation to your development workflow. Run it after each migration:

```bash
pgstack migration up && pgstack generate types --output src/types/database.ts
```

Or add it as an npm script:

```json
{
  "scripts": {
    "db:generate": "pgstack generate types --output src/types/database.ts",
    "db:migrate": "pgstack migration up && npm run db:generate"
  }
}
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--output <path>` | stdout | Write types to this file |
| `--db-url <url>` | From `.env` | PostgreSQL connection string |
| `--schema <name>` | `public` | Schema to generate types for |
| `--include-system` | false | Include `pgstack` and `pgr` schemas |
