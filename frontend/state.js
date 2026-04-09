export const State = {
    LANDING: "LANDING",
    PROBE_LOADING: "PROBE_LOADING",
    PROBE_404: "PROBE_404",
    LISTEN_READY: "LISTEN_READY",
    LISTEN_LOADING: "LISTEN_LOADING",
    POST_LISTEN_RALLY: "POST_LISTEN_RALLY",
    POST_LISTEN_RALLY_REFRESH: "POST_LISTEN_RALLY_REFRESH",
    POST_LISTEN_TERMINAL: "POST_LISTEN_TERMINAL",
    POST_LISTEN_BURN_LOSER: "POST_LISTEN_BURN_LOSER",
    FIRST_SENT: "FIRST_SENT",
    RALLY_SENT: "RALLY_SENT",
};

export const Event = {
    START_LANDING: "START_LANDING",
    START_PROBE: "START_PROBE",
    START_REFRESH_RALLY: "START_REFRESH_RALLY",
    PROBE_OK: "PROBE_OK",
    PROBE_404: "PROBE_404",
    LISTEN_TAP: "LISTEN_TAP",
    LISTEN_200_RALLY: "LISTEN_200_RALLY",
    LISTEN_200_BURN_LOSER: "LISTEN_200_BURN_LOSER",
    LISTEN_200_TERMINAL: "LISTEN_200_TERMINAL",
    LISTEN_404: "LISTEN_404",
    SEND_TAP: "SEND_TAP",
    SEND_OK: "SEND_OK",
    SEND_REJECTED: "SEND_REJECTED",
    SEND_UNKNOWN: "SEND_UNKNOWN",
    COUNTDOWN_EXPIRED: "COUNTDOWN_EXPIRED",
    DISMISS: "DISMISS",
    PUSH_PROMPT_READY: "PUSH_PROMPT_READY",
    PUSH_RESOLVED: "PUSH_RESOLVED",
};

function invalid(current, event) {
    throw new Error(`undefined transition: ${current} + ${event}`);
}

function withDraft(payload, extras = {}) {
    return {
        ...payload.currentData,
        ...extras,
        sending: extras.sending ?? payload.currentData?.sending ?? false,
    };
}

function freshComposeData(payload = {}) {
    return {
        slug: payload.slug || "",
        text: "",
        customSlug: "",
        audio: null,
        sending: false,
        status: "",
        canRecord: true,
        recording: false,
        recordSeconds: 0,
    };
}

export function transition(current, event, payload = {}) {
    switch (event) {
        case Event.START_LANDING:
            return {
                next: State.LANDING,
                effects: ["register-sw", "stop-countdown", "clear-fragment"],
                data: freshComposeData(),
            };
        case Event.START_PROBE:
            return {
                next: State.PROBE_LOADING,
                effects: ["register-sw", "fetch-probe"],
                data: { slug: payload.slug },
            };
        case Event.START_REFRESH_RALLY:
            return {
                next: State.POST_LISTEN_RALLY_REFRESH,
                effects: ["register-sw", "start-countdown"],
                data: {
                    slug: payload.slug,
                    replyCode: payload.replyCode,
                    replyCodeExp: null,
                    phase: "refresh-degraded",
                    remainingMs: null,
                    text: "",
                    audio: null,
                    sending: false,
                    status: payload.status || "",
                    canRecord: true,
                    recording: false,
                    recordSeconds: 0,
                },
            };
        case Event.PROBE_OK:
            if (current !== State.PROBE_LOADING) invalid(current, event);
            return { next: State.LISTEN_READY, effects: [], data: { slug: payload.slug } };
        case Event.PROBE_404:
        case Event.LISTEN_404:
        case Event.COUNTDOWN_EXPIRED:
            return {
                next: State.PROBE_404,
                effects: ["clear-fragment", "stop-countdown"],
                data: { slug: payload.slug || payload.currentData?.slug || "" },
            };
        case Event.LISTEN_TAP:
            if (current !== State.LISTEN_READY) invalid(current, event);
            return {
                next: State.LISTEN_LOADING,
                effects: ["fetch-listen"],
                data: { slug: payload.slug || payload.currentData?.slug || "" },
            };
        case Event.LISTEN_200_RALLY:
            if (current !== State.LISTEN_LOADING) invalid(current, event);
            return {
                next: State.POST_LISTEN_RALLY,
                effects: ["write-fragment", "start-countdown"],
                data: {
                    slug: payload.slug,
                    content: payload.content,
                    replyCode: payload.replyCode,
                    replyCodeExp: payload.replyCodeExp,
                    phase: "calm",
                    remainingMs: null,
                    text: "",
                    audio: null,
                    sending: false,
                    status: "",
                    canRecord: true,
                    recording: false,
                    recordSeconds: 0,
                },
            };
        case Event.LISTEN_200_TERMINAL:
            if (current !== State.LISTEN_LOADING) invalid(current, event);
            return {
                next: State.POST_LISTEN_TERMINAL,
                effects: ["clear-fragment", "stop-countdown"],
                data: { slug: payload.slug, content: payload.content },
            };
        case Event.LISTEN_200_BURN_LOSER:
            if (current !== State.LISTEN_LOADING) invalid(current, event);
            return {
                next: State.POST_LISTEN_BURN_LOSER,
                effects: ["clear-fragment", "stop-countdown"],
                data: { slug: payload.slug, content: payload.content },
            };
        case Event.SEND_TAP:
            if (current === State.LANDING) {
                return {
                    next: State.LANDING,
                    effects: ["fetch-first-compose"],
                    data: withDraft(payload, { sending: true, status: payload.currentData?.status || "" }),
                };
            }
            if (current === State.POST_LISTEN_RALLY || current === State.POST_LISTEN_RALLY_REFRESH) {
                return {
                    next: current,
                    effects: ["fetch-rally-compose"],
                    data: withDraft(payload, { sending: true, status: payload.currentData?.status || "" }),
                };
            }
            invalid(current, event);
            break;
        case Event.SEND_OK:
            if (current === State.LANDING) {
                return {
                    next: State.FIRST_SENT,
                    effects: ["inspect-push"],
                    data: {
                        slug: payload.slug,
                        url: payload.url,
                        replyable: payload.replyable,
                        pushState: "checking",
                        pushReason: "",
                    },
                };
            }
            if (current === State.POST_LISTEN_RALLY || current === State.POST_LISTEN_RALLY_REFRESH) {
                return {
                    next: State.RALLY_SENT,
                    effects: ["clear-fragment", "stop-countdown", "inspect-push"],
                    data: {
                        slug: payload.slug,
                        replyable: payload.replyable,
                        pushState: "checking",
                        pushReason: "",
                    },
                };
            }
            invalid(current, event);
            break;
        case Event.SEND_REJECTED:
            if (current === State.LANDING) {
                return {
                    next: State.LANDING,
                    effects: [],
                    data: withDraft(payload, { sending: false, status: payload.status || "" }),
                };
            }
            if (current === State.POST_LISTEN_RALLY || current === State.POST_LISTEN_RALLY_REFRESH) {
                return {
                    next: State.PROBE_404,
                    effects: ["clear-fragment", "stop-countdown"],
                    data: { slug: payload.currentData?.slug || "" },
                };
            }
            invalid(current, event);
            break;
        case Event.SEND_UNKNOWN:
            if (current === State.LANDING) {
                return {
                    next: State.LANDING,
                    effects: [],
                    data: withDraft(payload, { sending: false, status: payload.status || "" }),
                };
            }
            if (current === State.POST_LISTEN_RALLY || current === State.POST_LISTEN_RALLY_REFRESH) {
                return {
                    next: State.PROBE_404,
                    effects: ["clear-fragment", "stop-countdown"],
                    data: { slug: payload.currentData?.slug || "" },
                };
            }
            invalid(current, event);
            break;
        case Event.PUSH_PROMPT_READY:
            if (current !== State.FIRST_SENT && current !== State.RALLY_SENT) invalid(current, event);
            return {
                next: current,
                effects: [],
                data: { ...payload.currentData, pushState: "prompt", pushReason: "" },
            };
        case Event.PUSH_RESOLVED:
            if (current === State.RALLY_SENT) {
                return {
                    next: State.PROBE_404,
                    effects: ["clear-fragment", "stop-countdown"],
                    data: { slug: payload.currentData?.slug || "" },
                };
            }
            if (current === State.FIRST_SENT) {
                return {
                    next: State.LANDING,
                    effects: ["clear-fragment", "stop-countdown"],
                    data: freshComposeData(),
                };
            }
            invalid(current, event);
            break;
        case Event.DISMISS:
            if (current === State.POST_LISTEN_TERMINAL || current === State.POST_LISTEN_BURN_LOSER) {
                return {
                    next: State.PROBE_404,
                    effects: ["clear-fragment", "stop-countdown"],
                    data: { slug: payload.currentData?.slug || "" },
                };
            }
            if (current === State.FIRST_SENT) {
                return {
                    next: State.LANDING,
                    effects: ["clear-fragment", "stop-countdown"],
                    data: freshComposeData(),
                };
            }
            invalid(current, event);
            break;
        default:
            invalid(current, event);
    }
}

function validSlug(slug) {
    return /^[a-z0-9-]{3,32}$/.test(slug) && !slug.startsWith("-") && !slug.endsWith("-");
}

function validReplyCode(code) {
    return /^[0-9A-HJKMNP-TV-Z]{4}$/.test(code);
}

export function initialState(pathname, hash) {
    const slug = pathname.replace(/^\/+/, "");
    if (!slug) {
        return { state: State.LANDING, data: freshComposeData() };
    }
    const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
    if (validSlug(slug) && validReplyCode(fragment)) {
        return {
            state: State.POST_LISTEN_RALLY_REFRESH,
            data: {
                slug,
                replyCode: fragment,
                replyCodeExp: null,
                phase: "refresh-degraded",
                remainingMs: null,
                text: "",
                audio: null,
                sending: false,
                status: "",
                canRecord: true,
                recording: false,
                recordSeconds: 0,
            },
        };
    }
    if (validSlug(slug)) {
        return { state: State.PROBE_LOADING, data: { slug } };
    }
    return { state: State.PROBE_404, data: { slug } };
}
