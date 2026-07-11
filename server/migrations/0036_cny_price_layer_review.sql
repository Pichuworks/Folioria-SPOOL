-- Existing initialized CNY instances may contain either the obsolete RMB x100 values or
-- canonical fen x100 values. Quarantine ordering until an operator explicitly reviews the
-- price layer with the pricing-scale CLI workflow. Fresh databases have no config row yet
-- and retain the canonical default when spool init runs after migrations.
UPDATE system_config
SET pricing_needs_reentry = 1
WHERE base_currency = 'CNY';
