#!/usr/bin/env sh
# Fills every "generate" in a .env with a fresh random value.
#
#   cp deploy/.env.production.example .env
#   sh deploy/generate-secrets.sh .env
#
# Run it once. Running it again rotates every secret, which will lock the kernel out of
# its own database until you also reset the roles.

set -eu
target="${1:-.env}"

if [ ! -f "$target" ]; then
	echo "no such file: $target" >&2
	exit 1
fi

if grep -q '=generate$' "$target"; then
	tmp="$(mktemp)"
	while IFS= read -r line; do
		case "$line" in
			*=generate)
				printf '%s%s\n' "${line%generate}" "$(openssl rand -hex 32)" ;;
			*)
				printf '%s\n' "$line" ;;
		esac
	done < "$target" > "$tmp"
	mv "$tmp" "$target"
	chmod 600 "$target"
	echo "filled every generated secret in $target"
else
	echo "nothing left to generate in $target"
fi
