function jsonHeaders() {
    return {
        "Content-Type": "application/json",
    };
}

function buildComposeBody(body) {
    const payload = {};
    if (body.text) {
        payload.text = body.text;
    }
    if (body.slug) {
        payload.slug = body.slug;
    }
    if (body.audio) {
        payload.audio_b64 = body.audio.b64;
        payload.audio_mime = body.audio.mime;
    }
    return payload;
}

async function request(path, options = {}) {
    try {
        const response = await fetch(path, options);
        let data = {};
        try {
            data = await response.json();
        } catch {
            data = {};
        }
        if (response.ok) {
            return { ok: true, data };
        }
        return {
            ok: false,
            status: response.status,
            reason: response.status === 404 ? "not_found" : response.status === 400 ? "malformed" : response.status === 409 ? "conflict" : "error",
            data,
        };
    } catch {
        return { ok: false, status: 0, reason: "network" };
    }
}

export async function compose(body) {
    return request("/api/compose", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(buildComposeBody(body)),
    });
}

export async function probe(slug) {
    return request(`/api/slug/${encodeURIComponent(slug)}`);
}

export async function peek(slug) {
    return request(`/api/slug/${encodeURIComponent(slug)}/peek`);
}

export async function listen(slug) {
    return request(`/api/slug/${encodeURIComponent(slug)}/listen`, {
        method: "POST",
        headers: jsonHeaders(),
        body: "{}",
    });
}

export async function rallyCompose(slug, body) {
    const payload = {
        reply_code: body.reply_code,
    };
    if (body.text) {
        payload.text = body.text;
    }
    if (body.audio) {
        payload.audio_b64 = body.audio.b64;
        payload.audio_mime = body.audio.mime;
    }
    return request(`/api/slug/${encodeURIComponent(slug)}/compose`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
    });
}

export async function subscribe(slug, body) {
    return request(`/api/slug/${encodeURIComponent(slug)}/subscribe`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
    });
}
