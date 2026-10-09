-- MySQL 演示库：与 PostgreSQL 演示库同构的迷你电商数据。
-- 建库由 MYSQL_DATABASE=demo 完成，本脚本在 demo 库内建表并填充数据。

CREATE TABLE customers (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(64)  NOT NULL,
    email      VARCHAR(128) NOT NULL UNIQUE,
    city       VARCHAR(32)  NOT NULL,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE = InnoDB;

CREATE TABLE products (
    id       INT AUTO_INCREMENT PRIMARY KEY,
    name     VARCHAR(64)    NOT NULL,
    category VARCHAR(32)    NOT NULL,
    price    DECIMAL(10, 2) NOT NULL,
    stock    INT            NOT NULL DEFAULT 0,
    CHECK (price >= 0)
) ENGINE = InnoDB;

CREATE TABLE orders (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    customer_id  INT           NOT NULL,
    status       VARCHAR(16)   NOT NULL DEFAULT 'pending',
    total_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
    created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
    INDEX idx_orders_customer (customer_id)
) ENGINE = InnoDB;

CREATE TABLE order_items (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    order_id   INT           NOT NULL,
    product_id INT           NOT NULL,
    quantity   INT           NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id),
    INDEX idx_order_items_order (order_id)
) ENGINE = InnoDB;

CREATE VIEW v_order_summary AS
SELECT o.id     AS order_id,
       c.name   AS customer,
       c.city   AS city,
       o.status AS status,
       COUNT(i.id)                    AS item_count,
       SUM(i.quantity * i.unit_price) AS order_total
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN order_items i ON i.order_id = o.id
GROUP BY o.id, c.name, c.city, o.status;

INSERT INTO customers (name, email, city)
WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 200)
SELECT CONCAT('客户', n),
CONCAT('user', n, '@example.com'),
ELT(1 + MOD(n, 6), '北京', '上海', '广州', '深圳', '杭州', '成都')
FROM seq;

INSERT INTO products (name, category, price, stock)
WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 120)
SELECT CONCAT('商品 ', n),
ELT(1 + MOD(n, 5), '键盘', '显示器', '鼠标', '耳机', '硬盘'),
ROUND(50 + MOD(n * 13, 2000), 2),
MOD(n, 100)
FROM seq;

INSERT INTO orders (customer_id, status)
WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 800)
SELECT 1 + MOD(n, 200), ELT(1 + MOD(n, 4), 'pending', 'paid', 'shipped', 'done')
FROM seq;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, 1 + MOD(o.id * 7, 120), 1 + MOD(o.id, 3), p.price
FROM orders o
JOIN products p ON p.id = 1 + MOD(o.id * 7, 120);

UPDATE orders o
JOIN (SELECT order_id, SUM(quantity * unit_price) AS total FROM order_items GROUP BY order_id) s
    ON s.order_id = o.id
SET o.total_amount = s.total;
