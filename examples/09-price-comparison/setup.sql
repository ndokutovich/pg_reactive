-- Example 9: Price Comparison Matrix
-- Demonstrates: Multiple window functions (RANK, NTILE, ratio to average/max)

CREATE EXTENSION IF NOT EXISTS pg_reactive;

SELECT pgr.subscribe('price_matrix',
  'SELECT id, name, category, price,
          RANK() OVER (ORDER BY price DESC) AS overall_rank,
          NTILE(4) OVER (ORDER BY price) AS price_quartile,
          ROUND((price / AVG(price) OVER ())::numeric, 2) AS vs_avg_ratio,
          ROUND((price / MAX(price) OVER () * 100)::numeric, 1) AS pct_of_max
   FROM products
   ORDER BY price DESC');
