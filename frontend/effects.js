import * as api from "/api.js";
import * as audio from "/audio.js";
import * as countdown from "/countdown.js";
import * as fragment from "/fragment.js";
import * as push from "/push.js";

let emit = () => {};

export function setEmitter(fn) {
    emit = fn;
}

function buildContent(data) {
    let audioUrl = null;
    if (data.audio_b64 && data.audio_mime) {
        audioUrl = `data:${data.audio_mime};base64,${data.audio_b64}`;
    }
    return {
        text: data.text || "",
        audioUrl,
    };
}

const effectHandlers = {
    "register-sw": async () => push.registerSW(),
    "fetch-probe": async (payload) => {
        const slug = payload.slug || payload.currentData?.slug || "";
        const result = await api.probe(slug);
        if (result.ok) {
            return { event: "PROBE_OK", payload: { slug } };
        }
        return { event: "PROBE_404", payload: { slug } };
    },
    "fetch-listen": async (payload) => {
        const slug = payload.slug || payload.currentData?.slug || "";
        const result = await api.listen(slug);
        if (!result.ok) {
            return { event: "LISTEN_404", payload: { slug } };
        }
        const data = result.data;
        const base = {
            slug,
            content: buildContent(data),
        };
        if (data.terminated) {
            return { event: "LISTEN_200_TERMINAL", payload: base };
        }
        if (data.reply_code) {
            return {
                event: "LISTEN_200_RALLY",
                payload: {
                    ...base,
                    replyCode: data.reply_code,
                    replyCodeExp: data.reply_code_exp ? data.reply_code_exp * 1000 : null,
                },
            };
        }
        return { event: "LISTEN_200_BURN_LOSER", payload: base };
    },
    "fetch-first-compose": async (payload) => {
        const text = (payload.currentData?.text || "").trim();
        const slug = (payload.currentData?.customSlug || "").trim();
        const audioPayload = payload.currentData?.audio
            ? { b64: await audio.toBase64(payload.currentData.audio.blob), mime: payload.currentData.audio.mime }
            : undefined;
        const result = await api.compose({
            text,
            slug,
            audio: audioPayload,
        });
        if (result.ok) {
            return {
                event: "SEND_OK",
                payload: {
                    slug: result.data.slug,
                    url: result.data.url,
                    replyable: Boolean(audioPayload),
                },
            };
        }
        if (result.reason === "network") {
            return {
                event: "SEND_UNKNOWN",
                payload: { currentData: payload.currentData, status: "network failed. try again." },
            };
        }
        let status = "send failed.";
        if (result.status === 409) {
            status = "that slug is already taken.";
        } else if (result.status === 400) {
            status = result.data?.error || "malformed request.";
        }
        return {
            event: "SEND_REJECTED",
            payload: { currentData: payload.currentData, status },
        };
    },
    "fetch-rally-compose": async (payload) => {
        const text = (payload.currentData?.text || "").trim();
        const audioPayload = payload.currentData?.audio
            ? { b64: await audio.toBase64(payload.currentData.audio.blob), mime: payload.currentData.audio.mime }
            : undefined;
        const result = await api.rallyCompose(payload.currentData.slug, {
            reply_code: payload.currentData.replyCode,
            text,
            audio: audioPayload,
        });
        if (result.ok) {
            return {
                event: "SEND_OK",
                payload: {
                    slug: payload.currentData.slug,
                    replyable: Boolean(audioPayload),
                },
            };
        }
        if (result.reason === "network") {
            // Transport failed mid-send; server may or may not have
            // committed. Per SPEC §POST /api/slug/<id>/compose "Not
            // idempotent", don't retry automatically. Keep the draft.
            return {
                event: "SEND_UNKNOWN",
                payload: {
                    currentData: payload.currentData,
                    status: "turn lost. the write may still have landed.",
                },
            };
        }
        if (result.status === 404) {
            // Reply code consumed, expired, or slug gone. Channel dead.
            return {
                event: "SEND_STALE",
                payload: { currentData: payload.currentData },
            };
        }
        // 400 (malformed), anything else → keep the draft, surface status.
        let status = result.data?.error || "send rejected.";
        if (result.status === 400) {
            status = result.data?.error || "that reply was rejected. check the text or audio.";
        }
        return {
            event: "SEND_REJECTED",
            payload: { currentData: payload.currentData, status },
        };
    },
    "write-fragment": async (payload) => {
        fragment.writeReplyCode(payload.currentData?.replyCode || payload.replyCode);
        return { ok: true };
    },
    "clear-fragment": async () => {
        fragment.clearFragment();
        return { ok: true };
    },
    "start-countdown": async (payload) => {
        countdown.startCountdown({
            expiresAt: payload.currentData?.replyCodeExp ?? payload.replyCodeExp ?? null,
            onPhaseChange: (phase) => emit("COUNTDOWN_PHASE", { phase }),
            onTick: (remainingMs) => emit("COUNTDOWN_TICK", { remainingMs }),
            onExpire: () => emit("COUNTDOWN_EXPIRED", { slug: payload.currentData?.slug || payload.slug || "" }),
        });
        return { ok: true };
    },
    "stop-countdown": async () => {
        countdown.stopCountdown();
        return { ok: true };
    },
    "inspect-push": async (payload) => {
        const result = await push.inspectSubscription(payload.currentData?.slug || payload.slug, payload.currentData?.replyable ?? payload.replyable);
        if (result.ok && result.reason === "prompt") {
            return { event: "PUSH_PROMPT_READY", payload: { currentData: payload.currentData } };
        }
        return { kind: "push", result };
    },
    "push-subscribe": async (payload) => {
        return { kind: "push", result: await push.subscribe(payload.currentData.slug) };
    },
};

export async function run(name, payload = {}, ctx = {}) {
    const handler = effectHandlers[name];
    if (!handler) {
        throw new Error(`unknown effect ${name}`);
    }
    return handler(payload, ctx);
}
