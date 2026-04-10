import { Event, State, initialState, transition } from "/state.js";
import * as effects from "/effects.js";
import * as dom from "/dom.js";
import { canRecord, recordingState, startRecording, stopRecording, NoMicError, PermissionDeniedError } from "/audio.js";
import { dynamicRecordCap } from "/countdown.js";
import { readReplyCode } from "/fragment.js";
import * as copy from "/copy.js";

let currentState = State.PROBE_404;
let currentData = {};

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

    const tx = transition(currentState, event, { ...payload, currentData });

    // Revoke any outstanding draft blob URL that the next data frame
    // is about to drop. Without this, repeated rally turns leak blob:
    // URLs until reload. Only fires when the next data frame doesn't
    // carry the same audio object forward.
    const prevAudioUrl = currentData.audio?.url;
    const nextAudioUrl = tx.data?.audio?.url;
    if (prevAudioUrl && prevAudioUrl !== nextAudioUrl) {
        URL.revokeObjectURL(prevAudioUrl);
    }

    currentState = tx.next;
    currentData = tx.data || {};
    syncRecordCapabilities();
    dom.swapSurface(currentState, currentData);

    for (const effectName of tx.effects) {
        const result = await effects.run(effectName, { ...payload, currentData });
        if (result?.event) {
            await dispatch(result.event, result.payload || {});
        } else if (result?.kind === "push") {
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

function installInputHandlers() {
    document.addEventListener("input", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }
        if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && target.dataset.field === "text") {
            currentData.text = target.value;
            currentData.status = "";
            syncLiveComposer();
        }
        if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && target.dataset.field === "slug") {
            currentData.customSlug = target.value.toLowerCase();
        }
    });
}

function installClickHandlers() {
    document.addEventListener("click", async (event) => {
        const action = event.target instanceof Element ? event.target.closest("[data-action]") : null;
        if (!action) {
            return;
        }
        const { action: name } = action.dataset;
        if (name === "listen") {
            await dispatch(Event.LISTEN_TAP, {});
            return;
        }
        if (name === "send") {
            if (!(currentData.text || "").trim() && !currentData.audio) {
                currentData.status = copy.LANDING_STATUS_REQUIRED;
                syncLiveComposer();
                return;
            }
            await dispatch(Event.SEND_TAP, {});
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
        if (name === "dismiss") {
            await dispatch(Event.DISMISS, {});
            return;
        }
        if (name === "copy-link") {
            await navigator.clipboard.writeText(currentData.url || "");
            currentData.pushReason = copy.COPY_DONE;
            currentData.pushState = "resolved";
            rerender();
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
        if (name === "new-confession") {
            await dispatch(Event.DISMISS, {});
        }
    });
}

function bootstrap() {
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
        // Ambiguity resolution: refresh keeps the fragment reply capability but not exact timer state.
        dispatch(Event.START_REFRESH_RALLY, { slug: boot.data.slug, replyCode: readReplyCode(), status: copy.RALLY_STATUS_REFRESH });
        return;
    }
    currentState = State.PROBE_404;
    currentData = boot.data;
    rerender();
}

bootstrap();
installInputHandlers();
installClickHandlers();
