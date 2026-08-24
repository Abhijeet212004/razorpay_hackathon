# Credential isolation

The second half of the claim. The first half is a boot assertion inside each service,
which refuses to start if a payment credential is present. This is the observable one.

```
checking that no service but the executor holds a payment credential
  ok    kernel
  ok    worker
  ok    web
  ok    buyer-agent
  ok    executor holds it, and is the only one

$ docker compose port executor 8081
no port 8081/tcp for container agentkit-executor-1: 
(no published port: the executor has no ingress at all)
```
