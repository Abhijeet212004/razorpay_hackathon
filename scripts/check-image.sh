#!/usr/bin/env bash
# What a judge with no GitHub account gets. No auth of any kind.
set -uo pipefail
IMAGE="${1:-abhijeet212004/agentkit}"
TAG="${2:-latest}"

TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:${IMAGE}:pull" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')

CODE=$(curl -s -o /tmp/agentkit-manifest.json -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json' \
  "https://ghcr.io/v2/${IMAGE}/manifests/${TAG}")

if [ "$CODE" != "200" ]; then
  echo "  HTTP ${CODE} — not anonymously pullable."
  echo "  Make the package public:"
  echo "  https://github.com/users/${IMAGE%%/*}/packages/container/${IMAGE##*/}/settings"
  exit 1
fi

python3 - <<'PY'
import json
d = json.load(open("/tmp/agentkit-manifest.json"))
archs = [
    f"{m['platform']['os']}/{m['platform']['architecture']}"
    for m in d.get("manifests", [])
    if m.get("platform", {}).get("architecture") != "unknown"
]
for a in archs:
    print(f"  ok  {a}")
need = {"linux/amd64", "linux/arm64"}
missing = need - set(archs)
if missing:
    raise SystemExit(f"  MISSING {', '.join(sorted(missing))} — an arm64 judge would fail outright.")
print(f"  anonymously pullable, {len(archs)} platforms. A judge on either architecture is fine.")
PY
