---
title: pgstack generate
sidebar_position: 5
description: Generate TypeScript types from your PostgreSQL schema.
---

# pgstack generate

Generate TypeScript type definitions from your PostgreSQL schema. Types are inferred from `information_schema` — columns, types, constraints, and nullability — so they stay in sync with your database.

## Usage

```bash
# Write to types/database.ts (default)
pgstack generate types

# Write to a file
pgstack generate types --output src/types/database.ts

# Specify a different database URL (DATABASE_URL env var, or .env in the project root)
DATABASE_URL=postgres://user:pass@host:5432/dbname pgstack generate types
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
          amount: number;
          created_at: string;
        };
        // ... Insert, Update
      };
    };
  };
}
```

The generated file also exports a `Json` type alias and per-table convenience types (`TodosRow`, `TodosInsert`, `TodosUpdate`, ...) so you can avoid the long indexed-access form.

## Using generated types with the SDK

```typescript
import type { Database } from './types/database';
import { createClient } from '@pgstack/sdk/pgstack';

const pgstack = createClient('http://127.0.0.1:8080', 'your-anon-key');

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
| `numeric`, `decimal`, `real`, `double precision` | `number` |
| `text`, `varchar`, `char`, `citext` | `string` |
| `boolean` | `boolean` |
| `uuid` | `string` |
| `json`, `jsonb` | `Json` (exported alias: `string \| number \| boolean \| null \| { [key: string]: Json \| undefined } \| Json[]`) |
| `timestamp`, `timestamptz` | `string` (ISO 8601) |
| `date` | `string` (YYYY-MM-DD) |
| `time`, `timetz` | `string` |
| `bytea` | `string` (base64) |
| any array type (`text[]`, `integer[]`, ...) | `unknown[]` |
| `ENUM` (and other user-defined types) | `string` |

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
pgstack migration run && pgstack generate types --output src/types/database.ts
```

Or add it as an npm script:

```json
{
  "scripts": {
    "db:generate": "pgstack generate types --output src/types/database.ts",
    "db:migrate": "pgstack migration run && npm run db:generate"
  }
}
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-o, --output <path>` | `types/database.ts` | Write generated types to this file |

The database connection comes from `DATABASE_URL` (environment variable or the project's `.env`). The schema list comes from the `schemas` array in `pgstack.config.json` (default `["public"]`). Tables named `pgstack_*` are always excluded.
