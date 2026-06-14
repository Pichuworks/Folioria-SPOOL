-- 0013: 配送方式/地址（Track C，D30）。orders 增 delivery 列。
-- delivery_method: 'pickup'（自取，默认）| 'shipping'（邮寄，须有地址）。既有订单默认自取。

ALTER TABLE orders ADD COLUMN delivery_method TEXT NOT NULL DEFAULT 'pickup';
ALTER TABLE orders ADD COLUMN delivery_address TEXT;
