/**
 * Server-side subscription management using PgReactiveAdmin.
 *
 * This shows how to register live queries programmatically
 * from a Node.js backend instead of raw SQL.
 *
 * Usage:
 *   npm install pg-reactive  (or use the local SDK)
 *   node server-setup.mjs
 */

import { PgReactiveAdmin } from '../../sdk/src/server.js';

const admin = new PgReactiveAdmin({
  connectionString: 'postgres://postgres:postgres@127.0.0.1:15432/pg_reactive_test'
});

try {
  // Register all three CRM dashboard queries

  const q1 = await admin.register('top_customers', `
    WITH customer_stats AS (
      SELECT customer_id, COUNT(*) AS order_count, SUM(total) AS total_spent
      FROM orders GROUP BY customer_id
    )
    SELECT c.name, c.region, cs.order_count, cs.total_spent
    FROM customers c
    JOIN customer_stats cs ON c.id = cs.customer_id
    ORDER BY cs.total_spent DESC
  `);
  console.log('Registered:', q1);

  const q2 = await admin.register('recent_orders', `
    SELECT o.id, c.name AS customer, p.name AS product, o.total, o.created_at
    FROM orders o
    JOIN customers c ON o.customer_id = c.id
    JOIN products p ON o.product_id = p.id
    ORDER BY o.created_at DESC
    LIMIT 10
  `);
  console.log('Registered:', q2);

  const q3 = await admin.register('revenue_by_region', `
    SELECT c.region, COUNT(DISTINCT c.id) AS customers,
           COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS revenue
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id
    GROUP BY c.region
    ORDER BY revenue DESC
  `);
  console.log('Registered:', q3);

  // List all active subscriptions
  const subs = await admin.listSubscriptions();
  console.log('\nActive subscriptions:');
  subs.forEach(s => console.log(`  ${s.query_id} (${s.num_tables} tables)`));

} finally {
  await admin.close();
}
