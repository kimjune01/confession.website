import { subscribe as subscribeApi } from "/api.js";
import * as store from "/subs-store.js";

function base64UrlToUint8Array(base64Url) {
    const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = (base64Url + padding).replaceAll("-", "+").replaceAll("_", "/");
    const raw = atob(base64);
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function vapidKey() {
    return document.documentElement.dataset.vapidPublicKey || "";
}

export async function registerSW() {
    if (!("serviceWorker" in navigator)) {
        return { ok: false, reason: "unsupported" };
    }
    try {
        await navigator.serviceWorker.register("/sw.js", { type: "module" });
        return { ok: true };
    } catch {
        return { ok: false, reason: "error" };
    }
}

export async function isSubscribed(slug) {
    const existing = await store.get(slug);
    return Boolean(existing);
}

export async function inspectSubscription(slug, replyable) {
    if (!replyable) {
        return { ok: false, reason: "not_replyable" };
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        return { ok: false, reason: "unsupported" };
    }
    if (!vapidKey()) {
        return { ok: false, reason: "unsupported" };
    }
    if (await isSubscribed(slug)) {
        return { ok: false, reason: "already_subscribed" };
    }
    if (Notification.permission === "denied") {
        return { ok: false, reason: "denied" };
    }
    if (Notification.permission === "granted") {
        return subscribe(slug);
    }
    return { ok: true, reason: "prompt" };
}

export async function subscribe(slug) {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        return { ok: false, reason: "unsupported" };
    }
    const key = vapidKey();
    if (!key) {
        return { ok: false, reason: "unsupported" };
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
            return { ok: false, reason: permission === "denied" ? "denied" : "dismissed" };
        }
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64UrlToUint8Array(key),
        });
        const json = subscription.toJSON();
        const response = await subscribeApi(slug, {
            endpoint: json.endpoint || "",
            p256dh: json.keys?.p256dh || "",
            auth: json.keys?.auth || "",
        });
        if (!response.ok) {
            return { ok: false, reason: response.reason || "error" };
        }
        await store.put({ slug_id: slug, subscribed_at: new Date().toISOString() });
        return { ok: true };
    } catch {
        return { ok: false, reason: "error" };
    }
}
