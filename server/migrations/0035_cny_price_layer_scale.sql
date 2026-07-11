-- 0035 originally multiplied every CNY price-layer value by 100 without evidence that
-- the database used the obsolete scale. Historical CNY scale is now reviewed explicitly;
-- keep this published version as a no-op marker so correctly scaled instances stay intact.
SELECT 1;
