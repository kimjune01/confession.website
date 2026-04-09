export const RESPONSE_FUSE_MS = 5 * 60 * 1000;
export const RECORD_TIMER_MS = 2 * 60 * 1000;
export const SUBMIT_DEADLINE_MS = RESPONSE_FUSE_MS + RECORD_TIMER_MS;

let intervalId = null;
let currentPhase = null;

function phaseForRemaining(remainingMs, expiresAt) {
    if (expiresAt == null) {
        return "refresh-degraded";
    }
    if (remainingMs <= 0) {
        return "hard-stop";
    }
    if (remainingMs <= RECORD_TIMER_MS) {
        return "overtime";
    }
    return "calm";
}

export function startCountdown({ expiresAt, onPhaseChange, onTick, onExpire }) {
    stopCountdown();

    if (expiresAt == null) {
        currentPhase = "refresh-degraded";
        onPhaseChange?.(currentPhase);
        onTick?.(null);
        return;
    }

    const tick = () => {
        const remainingMs = expiresAt - Date.now();
        const nextPhase = phaseForRemaining(remainingMs, expiresAt);
        if (nextPhase !== currentPhase) {
            currentPhase = nextPhase;
            onPhaseChange?.(currentPhase);
        }
        onTick?.(Math.max(remainingMs, 0));
        if (remainingMs <= 0) {
            stopCountdown();
            onExpire?.();
        }
    };

    tick();
    intervalId = window.setInterval(tick, 250);
}

export function stopCountdown() {
    if (intervalId != null) {
        window.clearInterval(intervalId);
        intervalId = null;
    }
    currentPhase = null;
}

export function dynamicRecordCap(nowMs, expiresAt) {
    if (expiresAt == null) {
        return RECORD_TIMER_MS;
    }
    return Math.min(RECORD_TIMER_MS, Math.max(expiresAt - nowMs, 0));
}
