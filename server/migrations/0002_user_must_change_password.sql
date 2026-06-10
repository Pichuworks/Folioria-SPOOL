-- D11（prd.md 附录 A）: spool init 创建的初始 admin 首次登录强制改密。
-- 改密成功后由应用层清零。
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
