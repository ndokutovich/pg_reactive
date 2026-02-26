import { postSql } from './sql';

export interface Subscription {
  query_id: string;
  query_text: string;
  invalidation_count: number;
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const result = await postSql('SELECT * FROM pgr.get_subscriptions()');
  if (result.error) throw new Error(result.error);
  return (result.rows ?? []).map((r) => ({
    query_id: r['query_id'] as string,
    query_text: r['query_text'] as string,
    invalidation_count: r['invalidation_count'] as number,
  }));
}
