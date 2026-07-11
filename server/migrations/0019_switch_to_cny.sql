-- 0019 originally deleted all operational history and forced every instance to CNY.
-- Currency is immutable after business data exists, so a generic startup migration must
-- never perform that operation. Keep this published version as a no-op marker.
SELECT 1;
