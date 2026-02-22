-- Example 4: Category Leaderboard (HAVING + Window Functions)
-- Run AFTER examples 1 and 2 setup.sql
-- docker compose exec -T db psql -U postgres -d pg_reactive_test -f /ext/examples/04-category-leaderboard/setup.sql

CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- Add products in more categories for better demo
INSERT INTO products (name, price, category) VALUES
  ('Headphones', 149.99, 'electronics'),
  ('Smart Watch', 249.99, 'electronics'),
  ('Running Shoes', 89.99, 'sports'),
  ('Yoga Mat', 29.99, 'sports'),
  ('Water Bottle', 14.99, 'sports'),
  ('Novel', 9.99, 'books'),
  ('Textbook', 59.99, 'books');

-- Subscription 1: Premium categories (avg price > $50)
SELECT pgr.subscribe('premium_categories',
  'SELECT category,
          ROUND(AVG(price)::numeric, 2) AS avg_price,
          COUNT(*) AS product_count
   FROM products
   GROUP BY category
   HAVING AVG(price) > 50'
);

-- Subscription 2: Product rankings within each category
SELECT pgr.subscribe('product_rankings',
  'SELECT id, name, category, price,
          RANK() OVER (PARTITION BY category ORDER BY price DESC) AS rank
   FROM products'
);
