/**
 * pgStack Query Builder — Supabase-compatible REST query API.
 *
 * Usage:
 *   const { data, error } = await pgstack.from('todos').select('*').eq('done', false)
 */

export interface PgStackResponse<T = unknown> {
  data: T | null;
  error: PgStackError | null;
  count: number | null;
  status: number;
  statusText: string;
}

export interface PgStackError {
  message: string;
  status: number;
}

type HeadersFn = () => Record<string, string>;

export class PgStackQueryBuilder {
  private baseUrl: string;
  private table: string;
  private headersFn: HeadersFn;
  private _select: string | null = null;
  private _filters: string[] = [];
  private _order: string[] = [];
  private _limit: number | null = null;
  private _offset: number | null = null;
  private _single = false;
  private _head = false;
  private _count: 'exact' | 'planned' | 'estimated' | null = null;

  constructor(baseUrl: string, table: string, headersFn: HeadersFn) {
    this.baseUrl = baseUrl;
    this.table = table;
    this.headersFn = headersFn;
  }

  /** SELECT columns. Supports embedding: select('*, comments(id, body)') */
  select(columns = '*', options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    this._select = columns;
    if (options?.count) this._count = options.count;
    if (options?.head) this._head = true;
    return this;
  }

  /** INSERT row(s). */
  async insert(
    values: Record<string, unknown> | Record<string, unknown>[],
    options?: { defaultToNull?: boolean },
  ): Promise<PgStackResponse> {
    return this.mutate('POST', values);
  }

  /** UPDATE rows matching filters. */
  async update(
    values: Record<string, unknown>,
  ): Promise<PgStackResponse> {
    return this.mutate('PATCH', values);
  }

  /** UPSERT row(s). */
  async upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): Promise<PgStackResponse> {
    // pgStack doesn't have built-in upsert yet — use INSERT with conflict hint header
    return this.mutate('POST', values);
  }

  /** DELETE rows matching filters. */
  async delete(): Promise<PgStackResponse> {
    return this.mutate('DELETE');
  }

  // ---- Filters ----

  eq(column: string, value: unknown): this {
    this._filters.push(`${enc(column)}=eq.${enc(String(value))}`);
    return this;
  }

  neq(column: string, value: unknown): this {
    this._filters.push(`${enc(column)}=neq.${enc(String(value))}`);
    return this;
  }

  gt(column: string, value: unknown): this {
    this._filters.push(`${enc(column)}=gt.${enc(String(value))}`);
    return this;
  }

  gte(column: string, value: unknown): this {
    this._filters.push(`${enc(column)}=gte.${enc(String(value))}`);
    return this;
  }

  lt(column: string, value: unknown): this {
    this._filters.push(`${enc(column)}=lt.${enc(String(value))}`);
    return this;
  }

  lte(column: string, value: unknown): this {
    this._filters.push(`${enc(column)}=lte.${enc(String(value))}`);
    return this;
  }

  like(column: string, pattern: string): this {
    this._filters.push(`${enc(column)}=like.${enc(pattern)}`);
    return this;
  }

  ilike(column: string, pattern: string): this {
    this._filters.push(`${enc(column)}=ilike.${enc(pattern)}`);
    return this;
  }

  is(column: string, value: 'null' | 'true' | 'false' | null | boolean): this {
    const v = value === null ? 'null' : String(value);
    this._filters.push(`${enc(column)}=is.${v}`);
    return this;
  }

  in(column: string, values: unknown[]): this {
    const list = values.map(v => enc(String(v))).join(',');
    this._filters.push(`${enc(column)}=in.(${list})`);
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    this._filters.push(`${enc(column)}=not.${operator}.${enc(String(value))}`);
    return this;
  }

  filter(column: string, operator: string, value: unknown): this {
    this._filters.push(`${enc(column)}=${operator}.${enc(String(value))}`);
    return this;
  }

  // ---- Ordering & Pagination ----

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    let clause = column;
    clause += options?.ascending === false ? '.desc' : '.asc';
    if (options?.nullsFirst === true) clause += '.nullsfirst';
    if (options?.nullsFirst === false) clause += '.nullslast';
    this._order.push(clause);
    return this;
  }

  limit(count: number): this {
    this._limit = count;
    return this;
  }

  range(from: number, to: number): this {
    this._offset = from;
    this._limit = to - from + 1;
    return this;
  }

  /** Return a single row (unwraps array to object). */
  single(): this {
    this._single = true;
    this._limit = 1;
    return this;
  }

  /** Return at most one row. Like single() but doesn't error on 0 rows. */
  maybeSingle(): this {
    this._single = true;
    this._limit = 1;
    return this;
  }

  // ---- Execute (for SELECT, called via .then() or await) ----

  /** Execute the query. For SELECT, returns data. */
  async then<TResult1 = PgStackResponse, TResult2 = never>(
    resolve?: (value: PgStackResponse) => TResult1 | PromiseLike<TResult1>,
    reject?: (reason: unknown) => TResult2 | PromiseLike<TResult2>,
  ): Promise<TResult1 | TResult2> {
    try {
      const result = await this.execute();
      return resolve ? resolve(result) : (result as unknown as TResult1);
    } catch (e) {
      if (reject) return reject(e);
      throw e;
    }
  }

  private async execute(): Promise<PgStackResponse> {
    const qs = this.buildQueryString();
    const url = `${this.baseUrl}/rest/v1/${enc(this.table)}${qs ? '?' + qs : ''}`;
    const headers = this.headersFn();

    if (this._head) {
      headers['Prefer'] = 'count=exact';
    }

    try {
      const res = await fetch(url, {
        method: this._head ? 'HEAD' : 'GET',
        headers,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return {
          data: null,
          error: { message: body.error || res.statusText, status: res.status },
          count: null,
          status: res.status,
          statusText: res.statusText,
        };
      }

      const data = this._head ? null : await res.json();

      // Handle single mode
      if (this._single && Array.isArray(data)) {
        return {
          data: data[0] ?? null,
          error: null,
          count: null,
          status: res.status,
          statusText: res.statusText,
        };
      }

      return {
        data,
        error: null,
        count: null,
        status: res.status,
        statusText: res.statusText,
      };
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : String(e), status: 0 },
        count: null,
        status: 0,
        statusText: 'Network Error',
      };
    }
  }

  private async mutate(method: string, body?: unknown): Promise<PgStackResponse> {
    const qs = this.buildQueryString();
    const url = `${this.baseUrl}/rest/v1/${enc(this.table)}${qs ? '?' + qs : ''}`;
    const headers = this.headersFn();

    const opts: RequestInit = { method, headers };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    try {
      const res = await fetch(url, opts);

      if (!res.ok) {
        const responseBody = await res.json().catch(() => ({}));
        return {
          data: null,
          error: { message: responseBody.error || res.statusText, status: res.status },
          count: null,
          status: res.status,
          statusText: res.statusText,
        };
      }

      const data = await res.json().catch(() => null);

      return {
        data,
        error: null,
        count: null,
        status: res.status,
        statusText: res.statusText,
      };
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : String(e), status: 0 },
        count: null,
        status: 0,
        statusText: 'Network Error',
      };
    }
  }

  private buildQueryString(): string {
    const parts: string[] = [];

    if (this._select) {
      parts.push(`select=${enc(this._select)}`);
    }

    parts.push(...this._filters);

    if (this._order.length > 0) {
      parts.push(`order=${this._order.join(',')}`);
    }

    if (this._limit !== null) {
      parts.push(`limit=${this._limit}`);
    }

    if (this._offset !== null) {
      parts.push(`offset=${this._offset}`);
    }

    return parts.join('&');
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
