import { env } from "@/lib/env";

interface CalNotifyPayload {
    title: string;
    notionPageUrl: string;
    summary?: string;
    recordingDate?: string;
}

/**
 * Fire-and-forget notification to Cal's webhook.
 * Cal sends a Telegram message with the Notion link.
 */
export function notifyCalWebhook(payload: CalNotifyPayload): void {
    const url = env.CAL_WEBHOOK_URL;
    if (!url) return;

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };

    if (env.CAL_WEBHOOK_SECRET) {
        headers["X-Webhook-Secret"] = env.CAL_WEBHOOK_SECRET;
    }

    fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
    }).catch((error) => {
        console.error("Cal webhook notification failed:", error);
    });
}
