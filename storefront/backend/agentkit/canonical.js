// JSON Canonicalization Scheme (RFC 8785). The kernel verifies signatures over exactly
// these bytes, so both sides must agree on them down to key order.
function canonicalise(value) {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) throw new Error('only safe integers may be canonicalised');
        return String(value);
    }
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`).join(',')}}`;
}

module.exports = { canonicalise };
