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
    if (remainingMs == null) {
        return "hurry";
    }
    return formatSeconds(Math.ceil(remainingMs / 1000));
}

function sendLabel(text, audio) {
    if (audio) {
        return copy.SEND_AUDIO_LABEL;
    }
    if ((text || "").trim()) {
        return copy.SEND_TEXT_LABEL;
    }
    return copy.SEND_DISABLED_LABEL;
}

function appendCompose(target, props) {
    const compose = cloneTemplate("tpl-compose");
    const status = compose.querySelector(".compose-status");
    const countdown = compose.querySelector(".countdown-card");
    const phase = compose.querySelector(".countdown-phase");
    const time = compose.querySelector(".countdown-time");
    const recordBtn = compose.querySelector(".record-btn");
    const recordTime = compose.querySelector(".record-time");
    const recordCaption = compose.querySelector(".record-caption");
    const audioPreview = compose.querySelector(".audio-preview");
    const previewAudio = audioPreview.querySelector("audio");
    const text = compose.querySelector(".compose-text");
    const sendBtn = compose.querySelector(".send-btn");
    const disclosure = compose.querySelector(".slug-disclosure");
    const slugInput = compose.querySelector(".slug-input");

    text.value = props.text || "";
    sendBtn.textContent = props.sending ? copy.LANDING_STATUS_SENDING : sendLabel(props.text, props.audio);
    sendBtn.disabled = props.sending || (!(props.text || "").trim() && !props.audio);

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

    recordBtn.classList.toggle("is-recording", Boolean(props.recording));
    recordBtn.disabled = props.sending || !props.canRecord || props.recordDisabled;
    recordTime.hidden = !props.recording;
    recordTime.textContent = formatSeconds(props.recordSeconds || 0);
    recordCaption.textContent = props.recordCaption || "";

    if (props.audio?.url) {
        audioPreview.hidden = false;
        previewAudio.src = props.audio.url;
    }

    if (props.hideSlug) {
        disclosure.hidden = true;
    } else {
        slugInput.value = props.customSlug || "";
    }

    target.append(compose);
}

function appendContent(target, content) {
    const node = cloneTemplate("tpl-content");
    if (content?.audioUrl) {
        node.querySelector(".played-audio").hidden = false;
        node.querySelector("audio").src = content.audioUrl;
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
        hideSlug: false,
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
    link.value = props.url || "";
    card.querySelector('[data-action="share-link"]').hidden = !navigator.share;
    renderPushPrompt(card, props);
    frame.querySelector(".surface-body").append(card);
    return frame;
}

export function render_probe_loading(props = {}) {
    const frame = brandFrame(copy.PROBE_LOADING_HEADLINE, copy.PROBE_LOADING_RULES);
    const body = frame.querySelector(".surface-body");
    const note = cloneTemplate("tpl-empty");
    note.querySelector(".inline-note").textContent = props.slug || copy.LOADING_TEXT;
    note.querySelector('[data-action="dismiss"]').hidden = true;
    body.append(note);
    return frame;
}

export function render_probe_404() {
    const frame = brandFrame(copy.NOTHING_HERE, "");
    frame.classList.add("is-empty");
    frame.querySelector(".rules").hidden = true;
    return frame;
}

export function render_listen_ready() {
    const frame = brandFrame(copy.LISTEN_READY_HEADER, copy.LISTEN_READY_RULES);
    frame.querySelector(".surface-body").append(cloneTemplate("tpl-listen-ready"));
    return frame;
}

export function render_listen_loading() {
    const frame = brandFrame(copy.LISTEN_LOADING_HEADER, copy.LISTEN_LOADING_RULES);
    const card = cloneTemplate("tpl-empty");
    card.querySelector(".inline-note").textContent = copy.LOADING_TEXT;
    card.querySelector('[data-action="dismiss"]').hidden = true;
    frame.querySelector(".surface-body").append(card);
    return frame;
}

export function render_post_listen_rally(props = {}) {
    const frame = brandFrame(copy.RALLY_HEADER, copy.RALLY_RULES);
    const body = frame.querySelector(".surface-body");
    appendContent(body, props.content);
    appendCompose(body, {
        ...props,
        hideSlug: true,
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
        hideSlug: true,
        recordCaption: props.canRecord ? copy.RALLY_STATUS_REFRESH : copy.LANDING_STATUS_RECORDING_UNAVAILABLE,
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
    const frame = brandFrame(copy.RALLY_SENT_HEADLINE, copy.RALLY_SENT_RULES);
    const card = cloneTemplate("tpl-rally-sent");
    card.querySelector(".inline-note").textContent = copy.RALLY_SENT_NOTE;
    renderPushPrompt(card, props);
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
    const recordBtn = compose.querySelector(".record-btn");
    const recordTime = compose.querySelector(".record-time");
    const recordCaption = compose.querySelector(".record-caption");
    const audioPreview = compose.querySelector(".audio-preview");
    const previewAudio = audioPreview?.querySelector("audio");
    const text = compose.querySelector(".compose-text");
    const sendBtn = compose.querySelector(".send-btn");
    const slugInput = compose.querySelector(".slug-input");

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

    if (recordBtn) {
        recordBtn.classList.toggle("is-recording", Boolean(props.recording));
        recordBtn.disabled = props.sending || !props.canRecord || props.recordDisabled;
    }

    if (recordTime) {
        recordTime.hidden = !props.recording;
        recordTime.textContent = formatSeconds(props.recordSeconds || 0);
    }

    if (recordCaption) {
        recordCaption.textContent = props.recordCaption || "";
    }

    if (previewAudio && audioPreview) {
        if (props.audio?.url) {
            audioPreview.hidden = false;
            if (previewAudio.src !== props.audio.url) {
                previewAudio.src = props.audio.url;
            }
        } else {
            audioPreview.hidden = true;
            previewAudio.removeAttribute("src");
        }
    }

    if (text) {
        if (document.activeElement !== text) {
            text.value = props.text || "";
        }
    }

    if (slugInput && document.activeElement !== slugInput) {
        slugInput.value = props.customSlug || "";
    }

    if (sendBtn) {
        sendBtn.textContent = props.sending ? copy.LANDING_STATUS_SENDING : sendLabel(props.text, props.audio);
        sendBtn.disabled = props.sending || (!(props.text || "").trim() && !props.audio);
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
