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
    // Recipient chose to terminate the channel with text (no audio).
    // Sent from POST_LISTEN_RALLY / POST_LISTEN_RALLY_REFRESH only.
    END_RALLY_TAP: "END_RALLY_TAP",
    SEND_OK: "SEND_OK",
    // Content rejection (400, 409 for user-supplied slug). Draft stays
    // alive; surface a status message and let the user retry.
    SEND_REJECTED: "SEND_REJECTED",
    // Reply-code stale / expired / slug gone (404 on rally compose).
    // The channel is dead; transition to PROBE_404.
    SEND_STALE: "SEND_STALE",
    // Network / transport failure with unknown commit outcome. SPEC
    // §POST /api/slug/<id>/compose says the write MAY have landed;
    // don't nuke the draft — keep the surface and let the user see
    // that something's wrong.
    SEND_UNKNOWN: "SEND_UNKNOWN",
    COUNTDOWN_EXPIRED: "COUNTDOWN_EXPIRED",
    DISMISS: "DISMISS",
    // PUSH_PROMPT_READY is no longer emitted — inspect-push returns
    // silent on the prompt case and the browser dialog is triggered
    // explicitly on copy-link. Kept as a key so old references don't
    // throw on lookup, but the event never fires.
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
                    replyCodeExp: payload.replyCodeExp || null,
                    phase: payload.replyCodeExp ? "calm" : "refresh-degraded",
                    remainingMs: null,
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
            return {
                next: State.LISTEN_READY,
                effects: [],
                data: { slug: payload.slug, replyCodeExp: payload.replyCodeExp || null },
            };
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
                data: {
                    slug: payload.slug || payload.currentData?.slug || "",
                    autoplay: Boolean(payload.autoplay),
                },
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
                // Optimistic: transition to FIRST_SENT immediately so the
                // user sees the next screen while the API call is in flight.
                // Draft is stashed in _draft for rollback on failure.
                return {
                    next: State.FIRST_SENT,
                    effects: ["fetch-first-compose"],
                    data: {
                        slug: "",
                        url: "",
                        replyable: false,
                        pushState: "",
                        pushReason: "",
                        _draft: { ...payload.currentData },
                    },
                };
            }
            if (current === State.POST_LISTEN_RALLY || current === State.POST_LISTEN_RALLY_REFRESH) {
                // Stop the countdown while the send is in flight so
                // COUNTDOWN_EXPIRED can't race ahead and flip state to
                // PROBE_404 while we're waiting for the API response.
                return {
                    next: current,
                    effects: ["stop-countdown", "fetch-rally-compose"],
                    data: withDraft(payload, { sending: true, status: payload.currentData?.status || "" }),
                };
            }
            invalid(current, event);
            break;
        case Event.END_RALLY_TAP:
            if (current === State.POST_LISTEN_RALLY || current === State.POST_LISTEN_RALLY_REFRESH) {
                return {
                    next: current,
                    effects: ["stop-countdown", "fetch-rally-end"],
                    data: withDraft(payload, { sending: true, ending: true, status: "" }),
                };
            }
            invalid(current, event);
            break;
        case Event.SEND_OK:
            if (current === State.FIRST_SENT) {
                // Optimistic path: we're already on FIRST_SENT from the
                // SEND_TAP transition. Now the API responded — fill in
                // the real URL and kick off push inspection.
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
                        ended: Boolean(payload.ended || payload.currentData?.ending),
                        pushState: "checking",
                        pushReason: "",
                    },
                };
            }
            invalid(current, event);
            break;
        case Event.SEND_REJECTED:
            // Optimistic rollback: if we're on FIRST_SENT (optimistic
            // transition from LANDING), revert to LANDING with the
            // stashed draft so the user's recording is preserved.
            if (current === State.FIRST_SENT && payload.currentData?._draft) {
                return {
                    next: State.LANDING,
                    effects: [],
                    data: { ...payload.currentData._draft, sending: false, status: payload.status || "" },
                };
            }
            if (
                current === State.POST_LISTEN_RALLY ||
                current === State.POST_LISTEN_RALLY_REFRESH
            ) {
                return {
                    next: current,
                    effects: [],
                    data: withDraft(payload, { sending: false, status: payload.status || "" }),
                };
            }
            invalid(current, event);
            break;
        case Event.SEND_STALE:
            // Reply code consumed / expired / slug gone. The channel
            // is dead — transition to PROBE_404 and clear the fragment.
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
            // Transport-level failure with unknown commit outcome.
            // Optimistic rollback if on FIRST_SENT.
            if (current === State.FIRST_SENT && payload.currentData?._draft) {
                return {
                    next: State.LANDING,
                    effects: [],
                    data: { ...payload.currentData._draft, sending: false, status: payload.status || "" },
                };
            }
            if (
                current === State.POST_LISTEN_RALLY ||
                current === State.POST_LISTEN_RALLY_REFRESH
            ) {
                return {
                    next: current,
                    effects: [],
                    data: withDraft(payload, { sending: false, status: payload.status || "" }),
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
