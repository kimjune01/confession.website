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
let fakeBlob = null;
let audioContext = null;
let analyser = null;
let levelRAF = null;

function startLevelLoop(onLevel) {
    if (!analyser) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
        if (!analyser) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        // Normalize to 0-1 against a softly-spoken reference; clamp at 1.
        const level = Math.min(avg / 80, 1);
        onLevel(level);
        levelRAF = requestAnimationFrame(tick);
    };
    tick();
}

function stopLevelLoop() {
    if (levelRAF != null) {
        cancelAnimationFrame(levelRAF);
        levelRAF = null;
    }
    if (analyser) {
        try { analyser.disconnect(); } catch {}
        analyser = null;
    }
    if (audioContext) {
        try { audioContext.close(); } catch {}
        audioContext = null;
    }
}

// Dev-only side door: tests running against localhost can bypass
// MediaRecorder by setting `window.__confessionFakeAudio` before
// clicking record. Headless browsers don't provide a real mic, so
// this is the only way to exercise the audio path end-to-end in
// automation.
//
// Shape (all keys optional except one of `bytes` / `b64`):
//   window.__confessionFakeAudio = {
//     bytes: Uint8Array | ArrayBuffer,   // OR
//     b64:   "<base64>",
//     mime:  "audio/ogg; codecs=opus",   // default ogg-opus
//     durationSec: 2,                    // default 1
//   };
//
// Gated on localhost / 127.0.0.1 so it is a no-op on any deployed
// origin. Not a production capability — not a secret, just inert.
function devSideDoorActive() {
    if (!(typeof window !== "undefined" && window.__confessionFakeAudio)) {
        return false;
    }
    const host = window.location?.hostname || "";
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function decodeFakeBytes(fake) {
    if (fake.bytes instanceof Uint8Array) return fake.bytes;
    if (fake.bytes instanceof ArrayBuffer) return new Uint8Array(fake.bytes);
    if (typeof fake.b64 === "string") {
        const raw = window.atob(fake.b64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }
    // Minimal non-empty fallback so the API accepts the blob.
    return new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // "OggS"
}

export function canRecord() {
    if (devSideDoorActive()) return true;
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
    stopLevelLoop();
    if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
    }
    mediaStream = null;
}

export async function startRecording(opts = {}) {
    if (devSideDoorActive()) {
        return startFakeRecording(opts);
    }
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

    // Voice-activity glow: mirror the mic level back to the caller so
    // the record button can pulse while the user is speaking. Optional
    // — falls through silently if the Web Audio API is unavailable or
    // the context can't start.
    try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (Ctor && opts.onLevel) {
            audioContext = new Ctor();
            if (audioContext.state === "suspended") {
                await audioContext.resume();
            }
            const source = audioContext.createMediaStreamSource(mediaStream);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            startLevelLoop(opts.onLevel);
        }
    } catch {
        stopLevelLoop();
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
    if (fakeBlob) {
        const result = fakeBlob;
        fakeBlob = null;
        cleanupInterval();
        state = "stopped";
        const resolver = stopResolve;
        stopResolve = null;
        const promise = stopPromise;
        stopPromise = null;
        resolver?.(result);
        return promise;
    }
    if (recorder && recorder.state === "recording") {
        recorder.stop();
        return stopPromise;
    }
    return null;
}

function startFakeRecording(opts = {}) {
    const fake = window.__confessionFakeAudio || {};
    const mime = fake.mime || "audio/ogg; codecs=opus";
    const bytes = decodeFakeBytes(fake);
    const blob = new Blob([bytes], { type: mime });
    const durationSec = Math.max(1, Number(fake.durationSec) || 1);

    fakeBlob = { blob, mime, durationSec };
    state = "recording";
    startedAt = Date.now();
    stopPromise = new Promise((resolve) => {
        stopResolve = resolve;
    });
    opts.onTick?.(0);
    tickTimer = window.setInterval(() => {
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        opts.onTick?.(sec);
        if (opts.maxSeconds && sec >= opts.maxSeconds) {
            stopRecording();
        }
    }, 250);
    return Promise.resolve();
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
