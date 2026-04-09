import { list } from "/subs-store.js";

async function handlePush(event) {
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const focused = windows.some((client) => client.focused);
        if (focused) {
            return;
        }
        await self.registration.showNotification("a new message on confession.website", {
            body: "open the most recent subscribed slug",
            tag: "confession.website",
        });
    })());
}

async function handleNotificationClick(event) {
    event.notification.close();
    event.waitUntil((async () => {
        const subscriptions = await list();
        const target = subscriptions[0];
        const url = target ? `/${target.slug_id}` : "/";
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of windows) {
            if ("focus" in client) {
                await client.focus();
                if ("navigate" in client) {
                    await client.navigate(url);
                }
                return;
            }
        }
        await self.clients.openWindow(url);
    })());
}

self.addEventListener("push", handlePush);
self.addEventListener("notificationclick", handleNotificationClick);
