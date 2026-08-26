-- The catalog is synced from the merchant's own product endpoint, by the worker.
--
-- The kernel reads it to price a basket and must not be able to rewrite it: a process
-- serving public HTTP has no business editing the prices it is about to quote.
GRANT INSERT ON catalog_items TO agentkit_worker;
GRANT UPDATE (name, category, price_paise, active) ON catalog_items TO agentkit_worker;

REVOKE INSERT ON catalog_items FROM agentkit_kernel;
