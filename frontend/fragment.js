const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function normalizeReplyCode(value) {
    const normalized = value.toUpperCase().replaceAll("-", "").replace(/\s+/g, "");
    if (normalized.length !== 4) {
        return null;
    }
    for (const ch of normalized) {
        if (!CROCKFORD.includes(ch)) {
            return null;
        }
    }
    return normalized;
}

export function readReplyCode() {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    if (!hash) {
        return null;
    }
    return normalizeReplyCode(hash);
}

export function writeReplyCode(code) {
    const normalized = normalizeReplyCode(code);
    if (!normalized) {
        return;
    }
    window.history.replaceState(null, "", `${window.location.pathname}#${normalized}`);
}

export function clearFragment() {
    window.history.replaceState(null, "", window.location.pathname);
}
