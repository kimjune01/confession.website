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
            const replyCodeExp = result.data?.reply_code_exp
                ? result.data.reply_code_exp * 1000
                : null;
            const hasAudio = Boolean(result.data?.has_audio);
            return { event: "PROBE_OK", payload: { slug, replyCodeExp, hasAudio } };
        }
        return { event: "PROBE_404", payload: { slug } };
    },
    // Phase 1: read-only peek returns audio without burning.
    "fetch-peek": async (payload) => {
        const slug = payload.slug || payload.currentData?.slug || "";
        const result = await api.peek(slug);
        if (!result.ok) {
            return { event: "LISTEN_404", payload: { slug } };
        }
        return {
            event: "PEEK_OK",
            payload: { slug, content: buildContent(result.data) },
        };
    },
    // Phase 2: burn commits the listen and returns the reply code.
    // Called after playback starts on LISTEN_PLAYING.
    "fetch-burn": async (payload) => {
        const slug = payload.slug || payload.currentData?.slug || "";
        const result = await api.listen(slug);
        if (!result.ok) {
            // Slug already burned (race) or gone — non-fatal.
            return { event: "BURN_FAILED", payload: { slug } };
        }
        const data = result.data;
        if (data.terminated) {
            return { event: "BURN_OK", payload: { slug, terminated: true } };
        }
        if (data.reply_code) {
            return {
                event: "BURN_OK",
                payload: {
                    slug,
                    replyCode: data.reply_code,
                    replyCodeExp: data.reply_code_exp ? data.reply_code_exp * 1000 : null,
                },
            };
        }
        // Burn race loser — someone else listened first
        return { event: "BURN_OK", payload: { slug, burnLoser: true } };
    },
    "fetch-first-compose": async (payload) => {
        // Optimistic UI: the audio lives in _draft (stashed from
        // LANDING data) since the FIRST_SENT data frame doesn't
        // carry it at the top level.
        const audioData = payload.currentData?.audio || payload.currentData?._draft?.audio;
        const audioPayload = audioData
            ? { b64: await audio.toBase64(audioData.blob), mime: audioData.mime }
            : undefined;
        const result = await api.compose({
            text: "",
            slug: "",
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
    "fetch-rally-end": async (payload) => {
        // Text-as-terminator: send a non-empty text field with no audio.
        // Per SPEC, text-only compose on a rally turn terminates the
        // channel. The text content is visible to the other side via
        // the "show text" button on their listen screen.
        const text = payload.currentData?.endText || "·";
        const result = await api.rallyCompose(payload.currentData.slug, {
            reply_code: payload.currentData.replyCode,
            text,
            audio: undefined,
        });
        if (result.ok) {
            return {
                event: "SEND_OK",
                payload: {
                    slug: payload.currentData.slug,
                    replyable: false,
                    ended: true,
                },
            };
        }
        if (result.reason === "network") {
            return {
                event: "SEND_UNKNOWN",
                payload: {
                    currentData: payload.currentData,
                    status: "connection dropped. your reply may have gone through.",
                },
            };
        }
        if (result.status === 404) {
            return {
                event: "SEND_STALE",
                payload: { currentData: payload.currentData },
            };
        }
        let status = result.data?.error || "send rejected.";
        if (result.status === 400) {
            status = result.data?.error || "couldn't end the channel.";
        }
        return {
            event: "SEND_REJECTED",
            payload: { currentData: payload.currentData, status },
        };
    },
    "fetch-rally-compose": async (payload) => {
        const audioPayload = payload.currentData?.audio
            ? { b64: await audio.toBase64(payload.currentData.audio.blob), mime: payload.currentData.audio.mime }
            : undefined;
        const result = await api.rallyCompose(payload.currentData.slug, {
            reply_code: payload.currentData.replyCode,
            text: "",
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
        // Prompt state is surfaced explicitly on the copy-link click,
        // not auto-prompted after seal. Everything else (already
        // subscribed, silently auto-subscribed on grant, unsupported,
        // denied) flows through the normal push result path.
        if (result.ok && result.reason === "prompt") {
            return { kind: "push", silent: true };
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
