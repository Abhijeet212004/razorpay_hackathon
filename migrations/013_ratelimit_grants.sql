-- LMT-005 needs the kernel to write buckets, and the edge runs before any lock.
--
-- UPDATE is column-scoped: the limiter may spend and refill tokens, and may not move a
-- bucket to another merchant.
GRANT UPDATE (tokens, refilled_at) ON rate_limit_buckets TO agentkit_kernel;

-- Buckets are ephemeral counters, so the worker prunes ones nothing has touched.
GRANT SELECT, DELETE ON rate_limit_buckets TO agentkit_worker;
