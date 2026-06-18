-- 0034: 切币防护栏（针对 review M8）。base_currency 切换后定价表 _c 数值含义随小数位变化（见 0019），
-- 须 admin 按新币种口径重录。新增标志由下单接口在其未清零前拒绝，避免静默按旧量级计价/下单。
-- 默认 0（不拦截）；未来任何币种切换迁移应同时置 1，admin 重录定价后于设置页清零。
ALTER TABLE system_config ADD COLUMN pricing_needs_reentry INTEGER NOT NULL DEFAULT 0;
