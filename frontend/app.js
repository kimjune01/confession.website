import { Event, State, initialState, transition } from "/state.js";
import * as effects from "/effects.js";
import * as dom from "/dom.js";
import { canRecord, recordingState, startRecording, stopRecording, NoMicError, PermissionDeniedError } from "/audio.js";
import { dynamicRecordCap } from "/countdown.js";
import { readReplyCode } from "/fragment.js";
import * as copy from "/copy.js";

let currentState = State.PROBE_404;
let currentData = {};

// Client-side 3 s countdown before the listen fetch fires. Tapping the
// active button during the countdown cancels it.
let listenCountdownInterval = null;

function stopListenCountdown() {
    if (listenCountdownInterval != null) {
        window.clearInterval(listenCountdownInterval);
        listenCountdownInterval = null;
    }
    if (currentData) {
        currentData.countdown = null;
    }
    const btn = document.querySelector(".listen-btn");
    if (btn) {
        btn.classList.remove("is-counting");
        btn.textContent = "listen just once";
    }
}

function startListenCountdown() {
    stopListenCountdown();
    currentData.countdown = { count: 3 };
    // Toggle button visuals directly — no full rerender needed since
    // we're just flipping a class and text on the same element.
    const btn = document.querySelector(".listen-btn");
    if (btn) {
        btn.classList.add("is-counting");
        btn.textContent = "save for later";
    }
    listenCountdownInterval = window.setInterval(() => {
        if (currentState !== State.LISTEN_READY || !currentData.countdown) {
            stopListenCountdown();
            return;
        }
        currentData.countdown.count -= 1;
        if (currentData.countdown.count <= 0) {
            stopListenCountdown();
            dispatch(Event.LISTEN_TAP, { autoplay: true });
            return;
        }
    }, 1000);
}

function syncRecordCapabilities() {
    currentData.canRecord = canRecord();
    currentData.recordDisabled = currentData.replyCodeExp ? dynamicRecordCap(Date.now(), currentData.replyCodeExp) <= 0 : false;
}

function rerender() {
    syncRecordCapabilities();
    dom.swapSurface(currentState, currentData);
}

function syncLiveComposer() {
    syncRecordCapabilities();
    dom.syncComposer({
        ...currentData,
        recordCaption: !currentData.canRecord
            ? copy.LANDING_STATUS_RECORDING_UNAVAILABLE
            : currentData.recording
                ? copy.RECORD_CAPTION_RECORDING
                : copy.RECORD_CAPTION_READY,
    });
}

function resolvePushReason(result) {
    if (result.ok) {
        return copy.PUSH_GRANTED;
    }
    switch (result.reason) {
        case "denied":
        case "dismissed":
            return copy.PUSH_DENIED;
        case "unsupported":
            return copy.PUSH_UNSUPPORTED;
        case "already_subscribed":
            return copy.PUSH_GRANTED;
        case "not_replyable":
            return copy.PUSH_SKIPPED;
        default:
            return copy.PUSH_SKIPPED;
    }
}

async function dispatch(event, payload = {}) {
    if (event === "COUNTDOWN_PHASE") {
        currentData.phase = payload.phase;
        currentData.recordDisabled = currentData.replyCodeExp ? dynamicRecordCap(Date.now(), currentData.replyCodeExp) <= 0 : false;
        syncLiveComposer();
        return;
    }
    if (event === "COUNTDOWN_TICK") {
        currentData.remainingMs = payload.remainingMs;
        currentData.recordDisabled = currentData.replyCodeExp ? dynamicRecordCap(Date.now(), currentData.replyCodeExp) <= 0 : false;
        syncLiveComposer();
        return;
    }

    let tx;
    try {
        tx = transition(currentState, event, { ...payload, currentData });
    } catch (e) {
        // Stale event from an in-flight effect whose source state has
        // already moved on (e.g. COUNTDOWN_EXPIRED raced ahead of a
        // pending SEND_OK). Drop it silently — the state machine has
        // already advanced past this event's relevance.
        console.warn("dispatch: dropping stale event", event, "in state", currentState, e.message);
        return;
    }

    // Revoke any outstanding draft blob URL that the next data frame
    // is about to drop. Without this, repeated rally turns leak blob:
    // URLs until reload. Only fires when the next data frame doesn't
    // carry the same audio object forward — AND the URL isn't stashed
    // in _draft for optimistic rollback.
    const prevAudioUrl = currentData.audio?.url;
    const nextAudioUrl = tx.data?.audio?.url;
    const draftAudioUrl = tx.data?._draft?.audio?.url;
    if (prevAudioUrl && prevAudioUrl !== nextAudioUrl && prevAudioUrl !== draftAudioUrl) {
        URL.revokeObjectURL(prevAudioUrl);
    }

    const prevState = currentState;
    currentState = tx.next;
    currentData = tx.data || {};
    syncRecordCapabilities();

    // Optimistic FIRST_SENT: when the API responds (SEND_OK) and we're
    // already showing FIRST_SENT, patch the link in-place instead of a
    // full swapSurface to avoid any flash.
    if (prevState === State.FIRST_SENT && currentState === State.FIRST_SENT) {
        dom.patchFirstSent(currentData);
    } else {
        dom.swapSurface(currentState, currentData);
    }

    for (const effectName of tx.effects) {
        const result = await effects.run(effectName, { ...payload, currentData });
        if (result?.event) {
            await dispatch(result.event, result.payload || {});
        } else if (result?.kind === "push") {
            // On FIRST_SENT, push prompts via copy-link (explicit
            // gesture). On RALLY_SENT, prompt immediately — the user
            // just sealed a reply and wants to know when the other
            // side responds. The "seal message" click is the gesture.
            if (result.silent) {
                if (currentState === State.RALLY_SENT && !currentData.ended) {
                    const pushResult = await effects.run("push-subscribe", { currentData });
                    if (pushResult?.kind === "push" && pushResult.result) {
                        currentData.pushState = "resolved";
                        currentData.pushReason = resolvePushReason(pushResult.result);
                        rerender();
                    }
                }
                continue;
            }
            currentData.pushState = "resolved";
            currentData.pushReason = resolvePushReason(result.result);
            if (currentState === State.RALLY_SENT && currentData.pushState === "resolved") {
                await dispatch(Event.PUSH_RESOLVED, {});
            } else {
                rerender();
            }
        }
    }
}

function setRecordGlow(level) {
    const btn = document.querySelector(".record-btn");
    if (btn) btn.style.setProperty("--glow-intensity", String(level));
}

async function handleRecordToggle() {
    if (!currentData.canRecord) {
        currentData.status = copy.LANDING_STATUS_RECORDING_UNAVAILABLE;
        syncLiveComposer();
        return;
    }
    if (recordingState() === "recording") {
        const recorded = await stopRecording();
        if (!recorded) {
            return;
        }
        if (currentData.audio?.url) {
            URL.revokeObjectURL(currentData.audio.url);
        }
        currentData.audio = {
            ...recorded,
            url: URL.createObjectURL(recorded.blob),
        };
        currentData.recording = false;
        currentData.recordSeconds = recorded.durationSec;
        currentData.status = "";
        setRecordGlow(0);
        syncLiveComposer();
        return;
    }

    try {
        const capMs = dynamicRecordCap(Date.now(), currentData.replyCodeExp ?? null);
        await startRecording({
            maxSeconds: Math.max(1, Math.floor(capMs / 1000)),
            onTick: (sec) => {
                currentData.recording = true;
                currentData.recordSeconds = sec;
                currentData.status = "";
                syncLiveComposer();
            },
            onLevel: (level) => {
                setRecordGlow(level);
            },
        });
    } catch (error) {
        if (error instanceof NoMicError || error instanceof PermissionDeniedError) {
            currentData.canRecord = false;
            currentData.status = copy.LANDING_STATUS_RECORDING_UNAVAILABLE;
            syncLiveComposer();
            return;
        }
        throw error;
    }
}


function installClickHandlers() {
    document.addEventListener("click", async (event) => {
        const action = event.target instanceof Element ? event.target.closest("[data-action]") : null;
        if (!action) {
            return;
        }
        const { action: name } = action.dataset;
        if (name === "listen") {
            if (currentData.countdown) {
                // Cancel — "save for later" = don't listen now
                stopListenCountdown();
            } else {
                startListenCountdown();
            }
            return;
        }
        if (name === "send") {
            if (!currentData.audio) {
                currentData.status = copy.LANDING_STATUS_REQUIRED;
                syncLiveComposer();
                return;
            }
            await dispatch(Event.SEND_TAP, {});
            return;
        }
        if (name === "end-rally") {
            await dispatch(Event.END_RALLY_TAP, {});
            return;
        }
        if (name === "toggle-record") {
            await handleRecordToggle();
            return;
        }
        if (name === "clear-audio") {
            if (currentData.audio?.url) {
                URL.revokeObjectURL(currentData.audio.url);
            }
            currentData.audio = null;
            syncLiveComposer();
            return;
        }
        if (name === "toggle-play") {
            // Locate the audio element relative to the clicked button
            // so this handler works for both compose-side previews
            // (.audio-preview) and listen-side playback (.played-audio).
            const container = action.closest(".audio-preview, .played-audio");
            const audioEl = container?.querySelector("audio");
            if (!audioEl) return;
            if (audioEl.paused) {
                try { await audioEl.play(); } catch { /* ignore — user can retry */ }
            } else {
                audioEl.pause();
            }
            return;
        }
        if (name === "dismiss") {
            await dispatch(Event.DISMISS, {});
            return;
        }
        if (name === "copy-link") {
            await navigator.clipboard.writeText(currentData.url || "");
            // Swap button text to a checkmark as confirmation instead
            // of showing a separate "copied." status line.
            action.textContent = "✓";
            action.disabled = true;
            // Handing off the link is the explicit user gesture that
            // lets us request push permission. Browsers require a
            // gesture for requestPermission; the copy click counts.
            if (
                typeof Notification !== "undefined" &&
                Notification.permission === "default" &&
                currentData.slug
            ) {
                const pushResult = await effects.run("push-subscribe", { currentData });
                if (pushResult?.kind === "push") {
                    currentData.pushReason = resolvePushReason(pushResult.result);
                    currentData.pushState = "resolved";
                    rerender();
                }
            }
            return;
        }
        if (name === "share-link" && navigator.share) {
            await navigator.share({ url: currentData.url || "", title: "confession.website" });
            return;
        }
        if (name === "push-yes") {
            const result = await effects.run("push-subscribe", { currentData });
            currentData.pushState = "resolved";
            currentData.pushReason = resolvePushReason(result.result);
            if (currentState === State.RALLY_SENT) {
                await dispatch(Event.PUSH_RESOLVED, {});
            } else {
                rerender();
            }
            return;
        }
        if (name === "push-no") {
            currentData.pushState = "resolved";
            currentData.pushReason = copy.PUSH_DENIED;
            if (currentState === State.RALLY_SENT) {
                await dispatch(Event.PUSH_RESOLVED, {});
            } else {
                rerender();
            }
            return;
        }
    });
}

async function bootstrap() {
    effects.setEmitter((event, payload) => {
        dispatch(event, payload).catch((error) => {
            console.error(error);
        });
    });
    const boot = initialState(window.location.pathname, window.location.hash);
    if (boot.state === State.LANDING) {
        dispatch(Event.START_LANDING, {});
        return;
    }
    if (boot.state === State.PROBE_LOADING) {
        dispatch(Event.START_PROBE, { slug: boot.data.slug });
        return;
    }
    if (boot.state === State.POST_LISTEN_RALLY_REFRESH) {
        // Probe first to get reply_code_exp so the countdown can show
        // a real timer instead of the generic "reply window open" nudge.
        // If the slug is gone (404), drop to nothing-here immediately.
        const probeResult = await effects.run("fetch-probe", { slug: boot.data.slug });
        if (probeResult?.event === "PROBE_404") {
            currentState = State.PROBE_404;
            currentData = { slug: boot.data.slug };
            rerender();
            return;
        }
        const replyCodeExp = probeResult?.payload?.replyCodeExp || null;
        dispatch(Event.START_REFRESH_RALLY, {
            slug: boot.data.slug,
            replyCode: readReplyCode(),
            replyCodeExp,
            status: "",
        });
        return;
    }
    currentState = State.PROBE_404;
    currentData = boot.data;
    rerender();
}

bootstrap().catch(console.error);
installClickHandlers();
