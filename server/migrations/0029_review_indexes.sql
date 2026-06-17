-- Performance indexes identified by code review
CREATE INDEX IF NOT EXISTS idx_jobs_paper_size_status ON jobs(paper_id, size_key, status);
CREATE INDEX IF NOT EXISTS idx_jobs_order_item ON jobs(order_item_id) WHERE order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consumables_printer ON consumables(printer_id) WHERE archived = 0;
CREATE INDEX IF NOT EXISTS idx_modes_printer ON print_modes(printer_id) WHERE archived = 0;
