-- Example 7: Multi-Filter Dashboard
-- Demonstrates: Multiple subscriptions on same table with different WHERE filters

CREATE EXTENSION IF NOT EXISTS pg_reactive;

SELECT pgr.subscribe('budget_products',
  'SELECT id, name, price, category FROM products WHERE price < 50 ORDER BY price');

SELECT pgr.subscribe('midrange_products',
  'SELECT id, name, price, category FROM products WHERE price >= 50 AND price < 200 ORDER BY price');

SELECT pgr.subscribe('premium_products',
  'SELECT id, name, price, category FROM products WHERE price >= 200 ORDER BY price');
