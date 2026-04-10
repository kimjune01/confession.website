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
        return `${minutes} minute${minutes === 1 ? "" : "s"} left`;
    }
    const seconds = Math.ceil(remainingMs / 1000);
    return `${seconds} second${seconds === 1 ? "" : "s"} left`;
}

function appendCompose(target, props) {
    const compose = cloneTemplate("tpl-compose");
    const status = compose.querySelector(".compose-status");
    const tabs = compose.querySelector(".compose-tabs");
    const audioPanel = compose.querySelector(".tab-panel-audio");
    const textPanel = compose.querySelector(".tab-panel-text");
    const countdown = audioPanel.querySelector(".countdown-card");
    const phase = audioPanel.querySelector(".countdown-phase");
    const time = audioPanel.querySelector(".countdown-time");
    const recordBtn = audioPanel.querySelector(".record-btn");
    const recordStatus = audioPanel.querySelector(".record-status");
    const recordTime = audioPanel.querySelector(".record-time");
    const recordCaption = audioPanel.querySelector(".record-caption");
    const audioPreview = audioPanel.querySelector(".audio-preview");
    const previewAudio = audioPreview.querySelector("audio");
    const audioActions = audioPanel.querySelector(".compose-actions");
    const sendBtn = audioActions.querySelector(".send-btn");

    const hasAudio = Boolean(props.audio?.url);
    const canEnd = Boolean(props.canEnd);

    sendBtn.textContent = props.sending ? copy.LANDING_STATUS_SENDING : copy.SEND_AUDIO_LABEL;
    sendBtn.disabled = props.sending || !hasAudio;

    if (props.status) {
        status.hidden = false;
        status.textContent = props.status;
    }

    // Countdown and record-time share the same grid slot (.record-status).
    // Mutually exclusive: recording timer wins when active, countdown otherwise.
    countdown.classList.toggle("is-invisible", Boolean(props.recording) || !props.phase);
    if (props.phase) {
        phase.textContent = props.phase.replaceAll("-", " ");
        time.textContent = formatRemaining(props.remainingMs);
        if (props.phase === "overtime") {
            compose.classList.add("is-overtime");
        }
        if (props.phase === "refresh-degraded") {
            compose.classList.add("is-refresh");
        }
    }

    // Show tabs on rally states so the user can switch between
    // recording audio (keeps the rally) and typing text (terminates).
    if (canEnd) {
        tabs.hidden = false;
    }

    // Step reveal: record stack is the initial control; once audio is
    // captured, it gives way to the preview + send actions.
    // compose-actions uses visibility (not hidden) so its height is
    // always reserved in the layout — prevents vertical shift when
    // the user finishes recording and the button appears.
    recordBtn.hidden = hasAudio;
    recordStatus.hidden = hasAudio;
    audioPreview.hidden = !hasAudio;
    audioActions.classList.toggle("is-invisible", !hasAudio);

    recordBtn.classList.toggle("is-recording", Boolean(props.recording));
    recordBtn.disabled = props.sending || !props.canRecord || props.recordDisabled;
    recordTime.textContent = formatSeconds(props.recordSeconds || 0);
    recordTime.classList.toggle("is-invisible", !props.recording);
    if (recordCaption) {
        recordCaption.textContent = props.recordCaption || "";
        recordCaption.hidden = !props.recordCaption;
    }

    if (hasAudio) {
        previewAudio.src = props.audio.url;
    }

    const playBtn = audioPanel.querySelector(".play-btn");
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
    const copyBtn = card.querySelector('[data-action="copy-link"]');
    card.querySelector('[data-action="share-link"]').hidden = !navigator.share;
    // Preserve the "copied" state across rerenders (e.g. after push-subscribe)
    if (props.copied && copyBtn) {
        copyBtn.textContent = "✓";
        copyBtn.disabled = true;
    }
    const note = card.querySelector(".inline-note");
    if (props.copied && note) {
        note.style.visibility = "visible";
        note.style.opacity = "1";
    }
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
    // Reuse the initial surface already in the HTML — it has the
    // divider in its final position from first paint. No new surface
    // element, no reveal animation, zero layout shift.
    const existing = document.getElementById("initial-surface");
    if (existing) {
        existing.removeAttribute("id");
        // Remove the reveal animation so the divider doesn't fade
        existing.classList.add("no-reveal");
        return existing;
    }
    // Fallback for non-slug pages that don't have the initial surface
    const frame = brandFrame(copy.LISTEN_READY_HEADER, "");
    frame.querySelector(".surface-body").classList.add("is-invisible");
    return frame;
}

// Patch the existing PROBE_LOADING surface in-place: update the
// headline and body content without replacing the surface element.
// The divider stays in the DOM untouched — zero layout shift.
let patchGeneration = 0;

// General in-place surface patch: render the target state, transplant
// headline + body into the existing surface. The divider stays in the
// DOM untouched — zero layout shift. Returns false if the target state
// isn't patchable (caller should fall back to swapSurface).
export function patchSurface(name, props = {}, { fadeDuration = 0.5, fadeHeadline = true } = {}) {
    const renderFn = {
        LANDING: render_landing,
        LISTEN_READY: render_listen_ready,
        LISTEN_PLAYING: render_listen_playing,
        PROBE_404: render_probe_404,
        POST_LISTEN_TERMINAL: render_post_listen_terminal,
        POST_LISTEN_BURN_LOSER: render_post_listen_burn_loser,
        POST_LISTEN_RALLY: render_post_listen_rally,
        POST_LISTEN_RALLY_REFRESH: render_post_listen_rally_refresh,
        RALLY_SENT: render_rally_sent,
    }[name];
    if (!renderFn) return false;

    const newFrame = renderFn(props);
    const headline = app.querySelector(".headline");
    const rules = app.querySelector(".rules");
    const body = app.querySelector(".surface-body");
    const brandBlock = app.querySelector(".brand-block");
    const divider = app.querySelector(".divider");

    // Transplant content from the new frame
    const newHeadline = newFrame.querySelector(".headline");
    const newRules = newFrame.querySelector(".rules");
    const newBody = newFrame.querySelector(".surface-body");
    const newDivider = newFrame.querySelector(".divider");

    if (divider && newDivider) divider.hidden = newDivider.hidden;

    // Cross-fade: placeholder fades out → content swaps → fades in.
    // Opacity-only — no blur (too expensive even on fast hardware).
    const swapAndFadeIn = () => {
        if (fadeHeadline && headline) {
            headline.textContent = newHeadline?.textContent || "";
            headline.classList.remove("placeholder-headline");
        }
        if (fadeHeadline && rules) {
            rules.textContent = newRules?.textContent || "";
            rules.hidden = newRules?.hidden || false;
        }
        if (body) {
            body.replaceChildren(...newBody.childNodes);
            body.classList.remove("is-invisible");
            body.style.opacity = "0";
            body.style.transition = `opacity ${fadeDuration}s cubic-bezier(0.25, 0.1, 0.25, 1)`;
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (fadeHeadline && brandBlock) brandBlock.style.opacity = "1";
                if (body) body.style.opacity = "1";
            });
        });
    };

    const ms = fadeDuration * 1000;
    const easing = `opacity ${fadeDuration}s cubic-bezier(0.25, 0.1, 0.25, 1)`;
    const gen = ++patchGeneration;
    if (fadeHeadline && brandBlock) {
        brandBlock.style.transition = easing;
        brandBlock.style.opacity = "0";
    }
    if (body) {
        body.style.transition = easing;
    }
    if (fadeHeadline) {
        setTimeout(() => {
            // Stale guard: if another transition fired during the
            // fade-out window, abort this delayed swap.
            if (gen === patchGeneration) swapAndFadeIn();
        }, ms);
    } else {
        // No headline fade — swap content immediately, only body fades in
        swapAndFadeIn();
    }
    return true;
}

export function render_listen_playing(props = {}) {
    const frame = brandFrame(copy.LISTEN_READY_HEADER, copy.RALLY_RULES);
    const body = frame.querySelector(".surface-body");
    appendContent(body, { ...props.content, autoplay: true });
    return frame;
}

export function render_probe_404() {
    const frame = brandFrame(copy.NOTHING_HERE, "");
    const body = frame.querySelector(".surface-body");
    const btn = document.createElement("a");
    btn.href = "/";
    btn.className = "send-btn send-btn-link";
    btn.textContent = "confess";
    body.append(btn);
    return frame;
}

export function render_listen_ready(props = {}) {
    const frame = brandFrame(copy.LISTEN_READY_HEADER, copy.LISTEN_READY_RULES);
    // Slower fade-in (0.7s) — this is the first thing the recipient
    // sees, give it a moment to breathe.
    frame.style.animationDuration = "0.7s";
    const card = cloneTemplate("tpl-listen-ready");
    const listenBtn = card.querySelector('[data-action="listen"]');
    const textBtn = card.querySelector('[data-action="show-text"]');
    if (props.hasAudio === false) {
        listenBtn.hidden = true;
        textBtn.hidden = false;
    }
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
    // No playback on the reply screen — the user already heard the
    // message on LISTEN_PLAYING. Just the compose UI.
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

    if (props.ended) {
        note.hidden = true;
        const prompt = card.querySelector(".push-prompt");
        if (prompt) prompt.hidden = true;
    } else if (props.pushAvailable) {
        // Push not yet granted — show CTA
        note.textContent = "want to know when they reply?";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "send-btn";
        btn.dataset.action = "push-now";
        btn.textContent = "get notified";
        btn.style.cssText = "align-self:center;width:70%;margin-top:var(--sp-3)";
        card.append(btn);
        const prompt = card.querySelector(".push-prompt");
        if (prompt) prompt.hidden = true;
    } else if (props.pushGranted) {
        note.textContent = "you'll be notified when they reply.";
        const prompt = card.querySelector(".push-prompt");
        if (prompt) prompt.hidden = true;
    } else {
        note.textContent = "check the link later to see if they replied.";
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
        LISTEN_PLAYING: render_listen_playing,
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

    const audioPanel = compose.querySelector(".tab-panel-audio");
    const status = compose.querySelector(".compose-status");
    const countdown = audioPanel?.querySelector(".countdown-card");
    const phase = audioPanel?.querySelector(".countdown-phase");
    const time = audioPanel?.querySelector(".countdown-time");
    const recordBtn = audioPanel?.querySelector(".record-btn");
    const recordStatus = audioPanel?.querySelector(".record-status");
    const recordTime = audioPanel?.querySelector(".record-time");
    const recordCaption = audioPanel?.querySelector(".record-caption");
    const audioPreview = audioPanel?.querySelector(".audio-preview");
    const previewAudio = audioPreview?.querySelector("audio");
    const audioActions = audioPanel?.querySelector(".compose-actions");
    const sendBtn = audioActions?.querySelector(".send-btn");

    const hasAudio = Boolean(props.audio?.url);

    if (status) {
        status.hidden = !props.status;
        status.textContent = props.status || "";
    }

    if (countdown && phase && time) {
        countdown.classList.toggle("is-invisible", Boolean(props.recording) || !props.phase);
        phase.textContent = props.phase ? props.phase.replaceAll("-", " ") : "";
        time.textContent = props.phase ? formatRemaining(props.remainingMs) : "";
        compose.classList.toggle("is-overtime", props.phase === "overtime");
        compose.classList.toggle("is-refresh", props.phase === "refresh-degraded");
    }

    if (recordBtn) {
        recordBtn.hidden = hasAudio;
    }
    if (recordStatus) {
        recordStatus.hidden = hasAudio;
    }

    if (recordBtn) {
        recordBtn.classList.toggle("is-recording", Boolean(props.recording));
        recordBtn.disabled = props.sending || !props.canRecord || props.recordDisabled;
    }

    if (recordTime) {
        recordTime.textContent = formatSeconds(props.recordSeconds || 0);
        recordTime.classList.toggle("is-invisible", !props.recording);
    }

    if (recordCaption) {
        recordCaption.textContent = props.recordCaption || "";
        recordCaption.hidden = !props.recordCaption;
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

    if (audioActions) {
        audioActions.classList.toggle("is-invisible", !hasAudio);
    }

    if (sendBtn) {
        sendBtn.textContent = props.sending ? copy.LANDING_STATUS_SENDING : copy.SEND_AUDIO_LABEL;
        sendBtn.disabled = props.sending || !hasAudio;
    }
}

export function cloneTemplate(id) {
    const template = document.getElementById(id);
    if (!template) {
        throw new Error(`Missing template ${id}`);
    }
    return template.content.firstElementChild.cloneNode(true);
}
