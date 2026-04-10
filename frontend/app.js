import { Event, State, initialState, transition } from "/state.js";
import * as api from "/api.js";
import * as effects from "/effects.js";
import * as dom from "/dom.js";
import { canRecord, recordingState, startRecording, stopRecording, NoMicError, PermissionDeniedError } from "/audio.js";
import { dynamicRecordCap } from "/countdown.js";
import { readReplyCode } from "/fragment.js";
import * as copy from "/copy.js";
import { buildContent } from "/content.js";

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
    prefetchPromise = null; // discard on cancel
    const btn = document.querySelector(".listen-btn");
    if (btn) {
        btn.classList.remove("is-counting");
        btn.textContent = "listen just once";
    }
}

let prefetchPromise = null;

function startListenCountdown() {
    stopListenCountdown();
    currentData.countdown = { count: 3 };

    // Peek: read-only fetch of audio data. No burn — the message
    // survives if the user cancels during the countdown. The burn
    // fires later (fetch-burn effect on LISTEN_PLAYING entry).
    const slug = window.location.pathname.replace(/^\/+/, "");
    prefetchPromise = effects.run("fetch-peek", {
        slug,
        currentData,
    });

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
            const pending = prefetchPromise;
            // Kill the interval but DON'T restore the button visual
            // yet — keep it in counting state until the dispatch fires
            // so there's no flash back to "listen just once".
            clearInterval(listenCountdownInterval);
            listenCountdownInterval = null;
            prefetchPromise = null;
            if (currentData) currentData.countdown = null;
            if (pending) {
                pending.then(async (result) => {
                    if (result?.event) {
                        await dispatch(result.event, result.payload || {});
                    }
                }).catch((err) => {
                    console.error(err);
                    // On error, restore the button
                    const btn = document.querySelector(".listen-btn");
                    if (btn) {
                        btn.classList.remove("is-counting");
                        btn.textContent = "listen just once";
                    }
                });
            } else {
                // Peek should always produce a result before countdown
                // completes. If prefetchPromise is null here, it means
                // peek was never started — log an error and restore UI.
                console.error("startListenCountdown: no prefetch promise at countdown end");
                const btn = document.querySelector(".listen-btn");
                if (btn) {
                    btn.classList.remove("is-counting");
                    btn.textContent = "listen just once";
                }
            }
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
    const prevDraftUrl = currentData._draft?.audio?.url;
    if (prevAudioUrl && prevAudioUrl !== nextAudioUrl && prevAudioUrl !== draftAudioUrl) {
        URL.revokeObjectURL(prevAudioUrl);
    }
    // Revoke draft blob URL when _draft is dropped (e.g. SEND_OK success)
    if (prevDraftUrl && prevDraftUrl !== nextAudioUrl && !tx.data?._draft) {
        URL.revokeObjectURL(prevDraftUrl);
    }

    const prevState = currentState;
    currentState = tx.next;
    currentData = tx.data || {};
    syncRecordCapabilities();

    // Same-state transitions that shouldn't trigger a full rerender:
    if (prevState === State.FIRST_SENT && currentState === State.FIRST_SENT) {
        dom.patchFirstSent(currentData);
    } else if (prevState === State.LISTEN_PLAYING && currentState === State.LISTEN_PLAYING) {
        // BURN_OK — data updated (replyCode populated), no visual change
    } else if (
        prevState === State.PROBE_LOADING &&
        dom.patchSurface(currentState, currentData)
    ) {
        // Patched in-place — divider stays, content cross-fades
    } else {
        // If the initial HTML surface still exists, patch it in-place
        // instead of replacing — prevents layout shift on first render
        // for both landing (/) and slug (/foo) pages.
        const initial = document.getElementById("initial-surface");
        if (initial) {
            initial.removeAttribute("id");
            initial.classList.add("no-reveal");
            dom.patchSurface(currentState, currentData, { fadeDuration: 0.5 });
        } else {
            dom.swapSurface(currentState, currentData);
        }
    }

    // Only bind listeners on state ENTRY (not same-state transitions
    // like BURN_OK which skip rerender but still reach this code).
    // Audio plays fully before advancing. 15 s pause countdown.
    // Voice-activity glow mirrors playback level on the play button.
    if (currentState === State.LISTEN_PLAYING && prevState !== State.LISTEN_PLAYING) {
        const audioEl = document.querySelector(".played-audio audio");
        if (audioEl) {
            let pauseInterval = null;
            let pauseRemaining = 15;
            let playbackAnalyser = null;
            let playbackRAF = null;

            // Wire up playback glow — same pattern as recording glow
            function startPlaybackGlow() {
                try {
                    const ctx = new (window.AudioContext || window.webkitAudioContext)();
                    if (ctx.state === "suspended") ctx.resume();
                    const source = ctx.createMediaElementSource(audioEl);
                    playbackAnalyser = ctx.createAnalyser();
                    playbackAnalyser.fftSize = 256;
                    source.connect(playbackAnalyser);
                    source.connect(ctx.destination); // still output to speakers
                    const dataArray = new Uint8Array(playbackAnalyser.frequencyBinCount);
                    function tick() {
                        if (!playbackAnalyser) return;
                        playbackAnalyser.getByteFrequencyData(dataArray);
                        let sum = 0;
                        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                        const avg = sum / dataArray.length;
                        const level = Math.min(avg / 80, 1);
                        const btn = document.querySelector(".played-audio .play-btn");
                        if (btn) btn.style.setProperty("--glow-intensity", String(level));
                        playbackRAF = requestAnimationFrame(tick);
                    }
                    tick();
                } catch {
                    // Web Audio unavailable — no glow, playback still works
                }
            }

            function stopPlaybackGlow() {
                if (playbackRAF) {
                    cancelAnimationFrame(playbackRAF);
                    playbackRAF = null;
                }
                const btn = document.querySelector(".played-audio .play-btn");
                if (btn) btn.style.setProperty("--glow-intensity", "0");
            }

            // Start glow on first play (createMediaElementSource can only be called once)
            let glowStarted = false;
            audioEl.addEventListener("play", () => {
                if (!glowStarted) {
                    glowStarted = true;
                    startPlaybackGlow();
                }
            }, { once: true });

            audioEl.addEventListener("pause", () => {
                if (audioEl.ended) return;
                pauseRemaining = 15;
                const btn = document.querySelector(".played-audio .play-btn");
                const icon = btn?.querySelector(".play-icon");
                pauseInterval = setInterval(() => {
                    pauseRemaining -= 0.1;
                    if (btn) {
                        // Opacity: 1 → 0 over 15s
                        btn.style.opacity = String(Math.max(0, pauseRemaining / 15));
                        // Border: brass → crimson at ≤10s
                        btn.style.borderColor = pauseRemaining <= 10 ? "var(--crimson)" : "";
                    }
                    if (icon) {
                        if (pauseRemaining <= 5) {
                            // Final 5s: show countdown number
                            icon.style.cssText = "font-size:1.2rem;transform:none;color:var(--crimson)";
                            icon.textContent = String(Math.ceil(pauseRemaining));
                        } else if (pauseRemaining <= 10) {
                            icon.style.cssText = "font-size:0.65rem;transform:none;white-space:nowrap;color:var(--crimson)";
                            icon.textContent = "you're losing it";
                        }
                    }
                    if (pauseRemaining <= 0) {
                        clearInterval(pauseInterval);
                        pauseInterval = null;
                        dispatch(Event.LISTEN_AUDIO_DONE, {}).catch(console.error);
                    }
                }, 100);
            });

            audioEl.addEventListener("play", () => {
                clearInterval(pauseInterval);
                pauseInterval = null;
                const btn = document.querySelector(".played-audio .play-btn");
                if (btn) {
                    btn.style.opacity = "";
                    btn.style.borderColor = "";
                    const icon = btn.querySelector(".play-icon");
                    if (icon) {
                        icon.style.cssText = "";
                        icon.textContent = "⏸";
                    }
                }
            });

            audioEl.addEventListener("ended", () => {
                clearInterval(pauseInterval);
                pauseInterval = null;
                stopPlaybackGlow();
                dispatch(Event.LISTEN_AUDIO_DONE, {}).catch(console.error);
            }, { once: true });
        }
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
                    // Don't auto-subscribe or redirect to 404.
                    // Stay on RALLY_SENT — it's the terminal screen
                    // for the replier. Push CTA is shown in the render.
                    currentData.pushAvailable = typeof Notification !== "undefined" && Notification.permission === "default";
                    currentData.pushGranted = typeof Notification !== "undefined" && Notification.permission === "granted";
                    rerender();
                }
                continue;
            }
            currentData.pushState = "resolved";
            currentData.pushReason = resolvePushReason(result.result);
            if (currentState === State.RALLY_SENT) {
                // Stay on RALLY_SENT — don't redirect to 404.
                // Update push status and rerender.
                currentData.pushGranted = result.result?.ok;
                currentData.pushAvailable = false;
                rerender();
            } else if (currentState === State.FIRST_SENT) {
                // Don't rerender — patchFirstSent already handled the
                // URL, and a full rebuild jankily flashes the screen.
                // Push on FIRST_SENT is triggered explicitly via
                // copy-link, not via the inspect-push result.
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
        // Guard: state may have changed while awaiting stopRecording
        if (currentState !== State.LANDING && currentState !== State.POST_LISTEN_RALLY && currentState !== State.POST_LISTEN_RALLY_REFRESH) {
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
            onAutoStop: (recorded) => {
                // Recording hit the time cap — consume the result
                // the same way a manual stop would. Guard against
                // state having moved on (e.g. COUNTDOWN_EXPIRED).
                if (!recorded) return;
                if (currentState !== State.LANDING && currentState !== State.POST_LISTEN_RALLY && currentState !== State.POST_LISTEN_RALLY_REFRESH) {
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
        // Tab switching for record/text on the reply screen.
        const tab = event.target instanceof Element ? event.target.closest("[data-tab]") : null;
        if (tab) {
            const tabName = tab.dataset.tab;
            const compose = tab.closest(".compose-card");
            if (!compose) return;
            compose.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("tab-active", b === tab));
            const audioPanel = compose.querySelector(".tab-panel-audio");
            const textPanel = compose.querySelector(".tab-panel-text");
            if (audioPanel) audioPanel.hidden = tabName !== "audio";
            if (textPanel) textPanel.hidden = tabName !== "text";
            // Update the rules text based on tab
            const rules = document.querySelector(".rules");
            if (rules) {
                rules.textContent = tabName === "text" ? copy.RALLY_TEXT_RULES : copy.RALLY_RULES;
            }
            if (tabName === "text") {
                const textarea = compose.querySelector(".compose-text");
                if (textarea) textarea.focus();
            }
            return;
        }

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
        if (name === "show-text") {
            action.disabled = true;
            const slug = window.location.pathname.replace(/^\/+/, "");
            const result = await api.listen(slug);
            if (!result.ok) {
                if (result.reason === "network") {
                    // Transient — re-enable and let the user retry
                    action.disabled = false;
                    return;
                }
                currentState = State.PROBE_404;
                currentData = { slug };
                dom.swapSurface(currentState, currentData);
                return;
            }
            currentState = State.POST_LISTEN_TERMINAL;
            currentData = { slug, content: buildContent(result.data) };
            dom.swapSurface(currentState, currentData);
            return;
        }
        if (name === "send-text") {
            if (currentData.sending) return;
            const textarea = document.querySelector(".compose-text");
            const text = textarea?.value?.trim() || "";
            if (!text) {
                currentData.status = "type something first.";
                syncLiveComposer();
                return;
            }
            action.disabled = true;
            currentData.endText = text;
            await dispatch(Event.END_RALLY_TAP, {});
            // Re-enable if we're still on the compose screen (send failed)
            if (currentState === State.POST_LISTEN_RALLY || currentState === State.POST_LISTEN_RALLY_REFRESH) {
                action.disabled = false;
            }
            return;
        }
        if (name === "send") {
            if (currentData.sending) return;
            if (!currentData.audio) {
                currentData.status = copy.LANDING_STATUS_REQUIRED;
                syncLiveComposer();
                return;
            }
            action.disabled = true;
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
            try {
                await navigator.clipboard.writeText(currentData.url || "");
            } catch {
                // Fallback: select the link field so the user can Cmd+C
                const linkField = document.querySelector(".link-out");
                if (linkField) { linkField.select(); }
                return;
            }
            action.textContent = "✓";
            action.disabled = true;
            // Persist so rerenders (e.g. after push-subscribe) don't reset
            currentData.copied = true;
            // Gentle fade in for the "check the link" hint. Double-rAF
            // ensures the browser paints at opacity 0 before the
            // transition to 1 begins — single rAF can batch both in
            // the same frame, causing a flash instead of a fade.
            const note = document.querySelector(".link-card .inline-note");
            if (note) {
                note.style.transition = "none";
                note.style.opacity = "0";
                note.style.visibility = "visible";
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        note.style.transition = "opacity 0.5s ease-out";
                        note.style.opacity = "1";
                    });
                });
            }
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
        if (name === "push-now") {
            action.disabled = true;
            const pushResult = await effects.run("push-subscribe", { currentData });
            if (pushResult?.kind === "push" && pushResult.result) {
                currentData.pushGranted = pushResult.result.ok;
                currentData.pushAvailable = false;
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
        // Remove the slug placeholder (not needed on landing).
        // Rename the landing placeholder to initial-surface so the
        // dispatch loop's patchSurface path picks it up.
        const slugSurface = document.getElementById("initial-surface");
        if (slugSurface) slugSurface.remove();
        const landingSurface = document.getElementById("landing-surface");
        if (landingSurface) {
            landingSurface.id = "initial-surface";
        }
        dispatch(Event.START_LANDING, {});
        return;
    }
    if (boot.state === State.PROBE_LOADING) {
        // Remove the landing preloader — slug pages use initial-surface
        const landingSurface = document.getElementById("landing-surface");
        if (landingSurface) landingSurface.remove();
        dispatch(Event.START_PROBE, { slug: boot.data.slug });
        return;
    }
    if (boot.state === State.POST_LISTEN_RALLY_REFRESH) {
        const landingSurface2 = document.getElementById("landing-surface");
        if (landingSurface2) landingSurface2.remove();
        // Probe first: if the slug has a NEW pending message (not
        // replyable — the old turn was replaced), ignore the stale
        // fragment and enter the normal listen flow. If replyable,
        // enter the rally-refresh with the timer.
        const probeResult = await effects.run("fetch-probe", { slug: boot.data.slug });
        if (probeResult?.event === "PROBE_404") {
            currentState = State.PROBE_404;
            currentData = { slug: boot.data.slug };
            rerender();
            return;
        }
        const replyable = Boolean(probeResult?.payload?.replyable);
        if (!replyable) {
            // Stale fragment — a new message is waiting. Clear the
            // hash and enter the listen flow.
            history.replaceState(null, "", window.location.pathname);
            dispatch(Event.START_PROBE, { slug: boot.data.slug });
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
