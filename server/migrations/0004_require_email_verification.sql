-- 0004: 邮箱验证「是否必需」改为可配置开关（默认 0=不要求）。
-- D17：下单门 email_unverified 仅在本开关为 1 时生效；验证邮件仍照常下发。
-- 修订 D12：原文将 403 email_unverified 表述为无条件，现改为受本开关控制。
ALTER TABLE system_config ADD COLUMN require_email_verification INTEGER NOT NULL DEFAULT 0;
