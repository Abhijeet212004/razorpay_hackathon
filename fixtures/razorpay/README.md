# Recorded rail fixtures

Responses captured from Razorpay Test Mode and replayed by the replay rail. They contain
no credentials: an API key never appears in a response body, and every recording is
scrubbed of request headers before it lands here.

Each fixture is keyed by the request the executor would make, so the replay rail matches
on method, path and a normalised body rather than on call order.
