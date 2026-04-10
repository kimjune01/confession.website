import * as copy from "/copy.js";

const app = document.getElementById("app");

function brandFrame(headline, rules) {
    const node = cloneTemplate("tpl-frame");
    node.querySelector(".headline").textContent = headline;
    node.querySelector(".rules").textContent = rules;
    return node;
}

function formatSeconds(seconds) {
    const safe = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(safe / 60);
    const secs = safe % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatRemaining(remainingMs) {
    // Refresh-degraded: no expiry timestamp available (page was
    // refreshed mid-window). Show a nudge instead of a timer.
    if (remainingMs == null) return "reply window open";
    if (remainingMs <= 0) return "";
    if (remainingMs >= 60000) {
        const minutes = Math.min(5, Math.ceil(remainingMs / 60000));
        return `${minutes} minute${minutes === 1 ? "" : "s"} left to reply`;
    }
    const seconds = Math.ceil(remainingMs / 1000);
    return `${seconds} second${seconds === 1 ? "" : "s"} left to reply`;
}

function appendCompose(target, props) {
    const compose = cloneTemplate("tpl-compose");
    const status = compose.querySelector(".compose-status");
    const countdown = compose.querySelector(".countdown-card");
    const phase = compose.querySelector(".countdown-phase");
    const time = compose.querySelector(".countdown-time");
    const recordStack = compose.querySelector(".record-stack");
    const recordBtn = compose.querySelector(".record-btn");
    const recordTime = compose.querySelector(".record-time");
    const recordCaption = compose.querySelector(".record-caption");
    const audioPreview = compose.querySelector(".audio-preview");
    const previewAudio = audioPreview.querySelector("audio");
    const composeActions = compose.querySelector(".compose-actions");
    const sendBtn = compose.querySelector(".send-btn");
    const rallyEnd = compose.querySelector(".rally-end");
    const endBtn = rallyEnd.querySelector('[data-action="end-rally"]');

    const hasAudio = Boolean(props.audio?.url);
    const canEnd = Boolean(props.canEnd);

    sendBtn.textContent = props.sending ? copy.LANDING_STATUS_SENDING : copy.SEND_AUDIO_LABEL;
    sendBtn.disabled = props.sending || !hasAudio;
    endBtn.textContent = copy.END_HERE_LABEL;
    endBtn.disabled = Boolean(props.sending);

    if (props.status) {
        status.hidden = false;
        status.textContent = props.status;
    }

    if (props.phase) {
        countdown.hidden = false;
        phase.textContent = props.phase.replaceAll("-", " ");
        time.textContent = formatRemaining(props.remainingMs);
        if (props.phase === "overtime") {
            compose.classList.add("is-overtime");
        }
        if (props.phase === "refresh-degraded") {
            compose.classList.add("is-refresh");
        }
    }

    // Step reveal: record stack is the initial control; once audio is
    // captured, it gives way to the preview + send actions. On rally
    // states, "end here" sits alongside the record button as a
    // terminator alternative — hidden mid-record and after audio is
    // captured, since both commit the user to an audio-bearing send.
    recordStack.hidden = hasAudio;
    audioPreview.hidden = !hasAudio;
    composeActions.hidden = !hasAudio;
    rallyEnd.hidden = !canEnd || hasAudio || Boolean(props.recording);

    recordBtn.classList.toggle("is-recording", Boolean(props.recording));
    recordBtn.disabled = props.sending || !props.canRecord || props.recordDisabled;
    // Keep .record-time in the layout flow with visibility (not [hidden])
    // so starting a recording doesn't push sibling content down.
    recordTime.textContent = formatSeconds(props.recordSeconds || 0);
    recordTime.style.visibility = props.recording ? "visible" : "hidden";
    recordCaption.textContent = props.recordCaption || "";
    recordCaption.hidden = !props.recordCaption;

    if (hasAudio) {
        previewAudio.src = props.audio.url;
    }

    // Custom play button — native <audio> is hidden, we toggle its
    // play/pause on the dedicated button and mirror the state into
    // the glyph via these listeners.
    const playBtn = compose.querySelector(".play-btn");
    const playIcon = playBtn.querySelector(".play-icon");
    previewAudio.addEventListener("play", () => {
        playBtn.classList.add("is-playing");
        playIcon.textContent = "⏸";
    });
    previewAudio.addEventListener("pause", () => {
        playBtn.classList.remove("is-playing");
        playIcon.textContent = "▶";
    });
    previewAudio.addEventListener("ended", () => {
        playBtn.classList.remove("is-playing");
        playIcon.textContent = "▶";
    });

    target.append(compose);
}

function appendContent(target, content) {
    const node = cloneTemplate("tpl-content");
    if (content?.audioUrl) {
        const played = node.querySelector(".played-audio");
        const audioEl = played.querySelector("audio");
        const playBtn = played.querySelector(".play-btn");
        const playIcon = playBtn.querySelector(".play-icon");
        played.hidden = false;
        if (content.autoplay) {
            audioEl.autoplay = true;
            // One-shot: if the state re-renders for any reason
            // (e.g. send rejected), don't restart playback.
            content.autoplay = false;
        }
        audioEl.src = content.audioUrl;
        audioEl.addEventListener("play", () => {
            playBtn.classList.add("is-playing");
            playIcon.textContent = "⏸";
        });
        audioEl.addEventListener("pause", () => {
            playBtn.classList.remove("is-playing");
            playIcon.textContent = "▶";
        });
        audioEl.addEventListener("ended", () => {
            playBtn.classList.remove("is-playing");
            playIcon.textContent = "▶";
        });
    }
    if (content?.text) {
        const p = node.querySelector(".message-text");
        p.hidden = false;
        p.textContent = content.text;
    }
    target.append(node);
}

function renderPushPrompt(container, props) {
    const prompt = container.querySelector(".push-prompt");
    if (!prompt) {
        return;
    }
    if (props.pushState === "prompt") {
        prompt.hidden = false;
        prompt.querySelector(".push-copy").textContent = copy.PUSH_PROMPT;
        return;
    }
    if (props.pushState === "resolved" && props.pushReason) {
        prompt.hidden = false;
        prompt.querySelector(".push-copy").textContent = props.pushReason;
        prompt.querySelector(".push-actions").hidden = true;
        return;
    }
    prompt.hidden = true;
}

export function render_landing(props = {}) {
    const frame = brandFrame(copy.LANDING_HEADLINE, copy.LANDING_RULES);
    appendCompose(frame.querySelector(".surface-body"), {
        ...props,
        phase: null,
        recordCaption: !props.canRecord
            ? copy.LANDING_STATUS_RECORDING_UNAVAILABLE
            : props.recording
                ? copy.RECORD_CAPTION_RECORDING
                : copy.RECORD_CAPTION_READY,
    });
    return frame;
}

export function render_first_sent(props = {}) {
    const frame = brandFrame(copy.FIRST_SENT_HEADLINE, copy.FIRST_SENT_RULES);
    const card = cloneTemplate("tpl-link-card");
    const link = card.querySelector(".link-out");
    // Optimistic: URL may be empty while the API is still in flight.
    // Show "sealing..." as placeholder. Copy/share buttons are always
    // visible (prevents layout shift) but disabled until the URL arrives.
    if (props.url) {
        link.value = props.url;
    } else {
        link.value = "";
        link.placeholder = copy.LANDING_STATUS_SENDING;
    }
    const actions = card.querySelector(".link-actions");
    if (actions) {
        actions.querySelectorAll("button").forEach((b) => { b.disabled = !props.url; });
    }
    card.querySelector('[data-action="share-link"]').hidden = !navigator.share;
    renderPushPrompt(card, props);
    frame.querySelector(".surface-body").append(card);
    return frame;
}

// In-place update for FIRST_SENT when the API responds with the real
// URL. Avoids a full swapSurface so there's no flash.
export function patchFirstSent(props = {}) {
    const link = app.querySelector(".link-out");
    if (link) {
        link.value = props.url || "";
        link.placeholder = "";
    }
    const actions = app.querySelector(".link-actions");
    if (actions) {
        actions.querySelectorAll("button").forEach((b) => { b.disabled = !props.url; });
    }
}

export function render_probe_loading() {
    // Show the same UI as LISTEN_READY but with all buttons disabled.
    // Probe fetch resolves in ~200 ms and the only visible change on
    // transition is the buttons becoming enabled — continuity instead
    // of an interstitial.
    const frame = brandFrame(copy.LISTEN_READY_HEADER, copy.LISTEN_READY_RULES);
    const card = cloneTemplate("tpl-listen-ready");
    card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    frame.querySelector(".surface-body").append(card);
    return frame;
}

export function render_probe_404() {
    const frame = brandFrame(copy.NOTHING_HERE, "");
    frame.classList.add("is-empty");
    frame.querySelector(".rules").hidden = true;
    return frame;
}

export function render_listen_ready(props = {}) {
    const frame = brandFrame(copy.LISTEN_READY_HEADER, copy.LISTEN_READY_RULES);
    const card = cloneTemplate("tpl-listen-ready");
    frame.querySelector(".surface-body").append(card);
    return frame;
}

export function render_listen_loading() {
    // Same continuity trick as render_probe_loading — hold the listen
    // surface with a disabled button while the fetch resolves.
    const frame = brandFrame(copy.LISTEN_READY_HEADER, copy.LISTEN_READY_RULES);
    const card = cloneTemplate("tpl-listen-ready");
    const btn = card.querySelector('[data-action="listen"]');
    if (btn) btn.disabled = true;
    frame.querySelector(".surface-body").append(card);
    return frame;
}

export function render_post_listen_rally(props = {}) {
    const frame = brandFrame(copy.RALLY_HEADER, copy.RALLY_RULES);
    const body = frame.querySelector(".surface-body");
    // Append the content card for autoplay wiring, but hide the visible
    // player — the user already heard (or saved) the message before
    // arriving here. The audio element stays in the DOM at 0×0 so
    // autoplay still fires on browsers that honour it.
    // Append the content card for autoplay wiring but hide it entirely
    // — the audio element stays in the DOM at 0×0 so autoplay fires,
    // but neither the player nor its divider are visible.
    appendContent(body, props.content);
    const contentCard = body.querySelector(".content-card");
    if (contentCard) {
        contentCard.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;opacity:0";
    }
    appendCompose(body, {
        ...props,
        canEnd: true,
        recordCaption: !props.canRecord
            ? copy.LANDING_STATUS_RECORDING_UNAVAILABLE
            : props.recording
                ? copy.RECORD_CAPTION_RECORDING
                : copy.RECORD_CAPTION_READY,
    });
    return frame;
}

export function render_post_listen_rally_refresh(props = {}) {
    const frame = brandFrame(copy.RALLY_HEADER, copy.REFRESH_RULES);
    const body = frame.querySelector(".surface-body");
    appendCompose(body, {
        ...props,
        canEnd: true,
        recordCaption: props.canRecord ? "" : copy.LANDING_STATUS_RECORDING_UNAVAILABLE,
    });
    return frame;
}

export function render_post_listen_terminal(props = {}) {
    const frame = brandFrame(copy.TERMINAL_LINE, copy.TERMINAL_LINE);
    const body = frame.querySelector(".surface-body");
    appendContent(body, props.content);
    const note = cloneTemplate("tpl-empty");
    note.querySelector(".inline-note").textContent = copy.TERMINAL_LINE;
    body.append(note);
    return frame;
}

export function render_post_listen_burn_loser(props = {}) {
    const frame = brandFrame(copy.BURN_LOSER_LINE, copy.BURN_LOSER_LINE);
    const body = frame.querySelector(".surface-body");
    appendContent(body, props.content);
    const note = cloneTemplate("tpl-empty");
    note.querySelector(".inline-note").textContent = copy.BURN_LOSER_LINE;
    body.append(note);
    return frame;
}

export function render_rally_sent(props = {}) {
    const headline = props.ended ? copy.RALLY_ENDED_HEADLINE : copy.RALLY_SENT_HEADLINE;
    const rules = props.ended ? copy.RALLY_ENDED_RULES : copy.RALLY_SENT_RULES;
    const frame = brandFrame(headline, rules);
    const card = cloneTemplate("tpl-rally-sent");
    const note = card.querySelector(".inline-note");
    note.textContent = props.ended ? "" : copy.RALLY_SENT_NOTE;
    note.hidden = !note.textContent;
    // An ended channel doesn't accept further pushes — skip the prompt.
    if (!props.ended) {
        renderPushPrompt(card, props);
    } else {
        const prompt = card.querySelector(".push-prompt");
        if (prompt) prompt.hidden = true;
    }
    frame.querySelector(".surface-body").append(card);
    return frame;
}

export function swapSurface(name, props = {}) {
    const renderFn = {
        LANDING: render_landing,
        FIRST_SENT: render_first_sent,
        PROBE_LOADING: render_probe_loading,
        PROBE_404: render_probe_404,
        LISTEN_READY: render_listen_ready,
        LISTEN_LOADING: render_listen_loading,
        POST_LISTEN_RALLY: render_post_listen_rally,
        POST_LISTEN_RALLY_REFRESH: render_post_listen_rally_refresh,
        POST_LISTEN_TERMINAL: render_post_listen_terminal,
        POST_LISTEN_BURN_LOSER: render_post_listen_burn_loser,
        RALLY_SENT: render_rally_sent,
    }[name];

    if (!renderFn) {
        throw new Error(`No renderer for ${name}`);
    }

    app.replaceChildren(renderFn(props));
}

export function syncComposer(props = {}) {
    const compose = app.querySelector(".compose-card");
    if (!compose) {
        return;
    }

    const status = compose.querySelector(".compose-status");
    const countdown = compose.querySelector(".countdown-card");
    const phase = compose.querySelector(".countdown-phase");
    const time = compose.querySelector(".countdown-time");
    const recordStack = compose.querySelector(".record-stack");
    const recordBtn = compose.querySelector(".record-btn");
    const recordTime = compose.querySelector(".record-time");
    const recordCaption = compose.querySelector(".record-caption");
    const audioPreview = compose.querySelector(".audio-preview");
    const previewAudio = audioPreview?.querySelector("audio");
    const composeActions = compose.querySelector(".compose-actions");
    const sendBtn = compose.querySelector(".send-btn");

    const hasAudio = Boolean(props.audio?.url);

    if (status) {
        status.hidden = !props.status;
        status.textContent = props.status || "";
    }

    if (countdown && phase && time) {
        countdown.hidden = !props.phase;
        phase.textContent = props.phase ? props.phase.replaceAll("-", " ") : "";
        time.textContent = props.phase ? formatRemaining(props.remainingMs) : "";
        compose.classList.toggle("is-overtime", props.phase === "overtime");
        compose.classList.toggle("is-refresh", props.phase === "refresh-degraded");
    }

    if (recordStack) {
        recordStack.hidden = hasAudio;
    }

    if (recordBtn) {
        recordBtn.classList.toggle("is-recording", Boolean(props.recording));
        recordBtn.disabled = props.sending || !props.canRecord || props.recordDisabled;
    }

    if (recordTime) {
        recordTime.textContent = formatSeconds(props.recordSeconds || 0);
        recordTime.style.visibility = props.recording ? "visible" : "hidden";
    }

    if (recordCaption) {
        recordCaption.textContent = props.recordCaption || "";
        recordCaption.hidden = !props.recordCaption;
    }

    const rallyEnd = compose.querySelector(".rally-end");
    if (rallyEnd) {
        const canEnd = Boolean(props.canEnd);
        rallyEnd.hidden = !canEnd || Boolean(props.audio?.url) || Boolean(props.recording);
        const endBtn = rallyEnd.querySelector('[data-action="end-rally"]');
        if (endBtn) {
            endBtn.disabled = Boolean(props.sending);
        }
    }

    if (previewAudio && audioPreview) {
        if (hasAudio) {
            audioPreview.hidden = false;
            if (previewAudio.src !== props.audio.url) {
                previewAudio.src = props.audio.url;
            }
        } else {
            audioPreview.hidden = true;
            previewAudio.pause();
            previewAudio.removeAttribute("src");
        }
    }

    if (composeActions) {
        composeActions.hidden = !hasAudio;
    }

    if (sendBtn) {
        sendBtn.textContent = props.sending ? copy.LANDING_STATUS_SENDING : copy.SEND_AUDIO_LABEL;
        sendBtn.disabled = props.sending || !hasAudio;
    }
}

export function disable(el) {
    if (el) {
        el.disabled = true;
    }
}

export function enable(el) {
    if (el) {
        el.disabled = false;
    }
}

export function textFor(key) {
    return copy[key];
}

export function cloneTemplate(id) {
    const template = document.getElementById(id);
    if (!template) {
        throw new Error(`Missing template ${id}`);
    }
    return template.content.firstElementChild.cloneNode(true);
}
