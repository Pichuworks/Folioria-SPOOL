-- 0005: 可选用户名登录（D18）。username 为可选第二登录标识，email 仍是通知/验证主干。
-- 部分唯一索引：COLLATE 必须落在「列」上才生效（落在 WHERE 上会退化为大小写敏感）；
-- WHERE username IS NOT NULL 让历史/访客等空 username 行不互相冲突。
ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX uniq_users_username ON users(username COLLATE NOCASE) WHERE username IS NOT NULL;
