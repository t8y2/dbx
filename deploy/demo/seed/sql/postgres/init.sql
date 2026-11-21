-- PostgreSQL 演示库：迷你电商（客户 / 商品 / 订单 / 订单明细 + 汇总视图）。
-- 建库由 POSTGRES_DB=demo 完成，本脚本在 demo 库内建表并填充数据。

CREATE TABLE customers (
    id           SERIAL PRIMARY KEY,
    name         TEXT        NOT NULL,
    email        TEXT        NOT NULL UNIQUE,
    city         TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id          SERIAL PRIMARY KEY,
    name        TEXT   NOT NULL,
    category    TEXT   NOT NULL,
    price       NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    stock       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE orders (
    id            SERIAL PRIMARY KEY,
    customer_id   INTEGER NOT NULL REFERENCES customers (id),
    status        TEXT    NOT NULL DEFAULT 'pending',
    total_amount  NUMERIC(12, 2) NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    id          SERIAL PRIMARY KEY,
    order_id    INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id  INTEGER NOT NULL REFERENCES products (id),
    quantity    INTEGER NOT NULL CHECK (quantity > 0),
    unit_price  NUMERIC(10, 2) NOT NULL
);

CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE INDEX idx_order_items_order ON order_items (order_id);

CREATE VIEW v_order_summary AS
SELECT o.id                AS order_id,
       c.name              AS customer,
       c.city              AS city,
       o.status            AS status,
       count(i.id)         AS item_count,
       sum(i.quantity * i.unit_price) AS order_total
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN order_items i ON i.order_id = o.id
GROUP BY o.id, c.name, c.city, o.status;

INSERT INTO customers (name, email, city, created_at)
SELECT '客户' || n,
       'user' || n || '@example.com',
       (ARRAY ['北京', '上海', '广州', '深圳', '杭州', '成都']) [1 + (n % 6)],
       now() - (n || ' days')::interval
FROM generate_series(1, 200) AS n;

INSERT INTO products (name, category, price, stock)
SELECT '商品 ' || n,
       (ARRAY ['键盘', '显示器', '鼠标', '耳机', '硬盘']) [1 + (n % 5)],
       round((50 + (n * 13 % 2000))::numeric, 2),
       n % 100
FROM generate_series(1, 120) AS n;

INSERT INTO orders (customer_id, status, total_amount, created_at)
SELECT 1 + (n % 200),
       (ARRAY ['pending', 'paid', 'shipped', 'done']) [1 + (n % 4)],
       0,
       now() - (n % 30 || ' hours')::interval
FROM generate_series(1, 800) AS n;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id,
       1 + ((o.id * 7) % 120),
       1 + (o.id % 3),
       p.price
FROM orders o
JOIN products p ON p.id = 1 + ((o.id * 7) % 120);

UPDATE orders o
SET total_amount = s.total
FROM (SELECT order_id, sum(quantity * unit_price) AS total FROM order_items GROUP BY order_id) s
WHERE s.order_id = o.id;

ANALYZE;
