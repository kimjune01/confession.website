export class NoMicError extends Error {}
export class PermissionDeniedError extends Error {}

let recorder = null;
let mediaStream = null;
let chunks = [];
let startedAt = 0;
let tickTimer = null;
let stopPromise = null;
let stopResolve = null;
let state = "idle";

export function canRecord() {
    return Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

export function pickMime() {
    if (!window.MediaRecorder) {
        return null;
    }
    const candidates = [
        "audio/ogg; codecs=opus",
        "audio/webm; codecs=opus",
    ];
    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || null;
}

export function recordingState() {
    return state;
}

function cleanupInterval() {
    if (tickTimer != null) {
        window.clearInterval(tickTimer);
        tickTimer = null;
    }
}

function cleanupTracks() {
    if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
    }
    mediaStream = null;
}

export async function startRecording(opts = {}) {
    if (!canRecord()) {
        throw new NoMicError("MediaRecorder unavailable");
    }
    const mime = pickMime();
    if (!mime) {
        throw new NoMicError("No supported MIME");
    }
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
        if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
            throw new PermissionDeniedError("Microphone denied");
        }
        throw error;
    }

    chunks = [];
    startedAt = Date.now();
    recorder = new MediaRecorder(mediaStream, { mimeType: mime });
    state = "recording";

    stopPromise = new Promise((resolve) => {
        stopResolve = resolve;
    });

    recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) {
            chunks.push(event.data);
        }
    });

    recorder.addEventListener("stop", () => {
        cleanupInterval();
        cleanupTracks();
        state = "stopped";
        const blob = new Blob(chunks, { type: recorder.mimeType || mime });
        const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        stopResolve?.({ blob, mime: recorder.mimeType || mime, durationSec });
        recorder = null;
    }, { once: true });

    recorder.start();
    opts.onTick?.(0);
    tickTimer = window.setInterval(() => {
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        opts.onTick?.(sec);
        if (opts.maxSeconds && sec >= opts.maxSeconds && recorder?.state === "recording") {
            recorder.stop();
        }
    }, 250);
}

export async function stopRecording() {
    if (recorder && recorder.state === "recording") {
        recorder.stop();
        return stopPromise;
    }
    return null;
}

export async function toBase64(blob) {
    const buffer = await blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return window.btoa(binary);
}
