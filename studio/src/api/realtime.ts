import { postSql } from './sql';

export interface Subscription {
  query_id: string;
  query_text: string;
  num_tables: number;
  subscribed_at: string;
  invalidation_count: number;
  mode: string;
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const result = await postSql('SELECT * FROM pgr.get_subscriptions()');
  if (result.error) throw new Error(result.error);
  return (result.rows ?? []).map((r) => ({
    query_id: r['query_id'] as string,
    query_text: r['query_text'] as string,
    num_tables: r['num_tables'] as number,
    subscribed_at: r['subscribed_at'] as string,
    invalidation_count: r['invalidation_count'] as number,
    mode: r['mode'] as string,
  }));
}
