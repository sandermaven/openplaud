import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { plaudConnections, userSettings, users } from "@/db/schema";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/notifications/email";

/** At most one mail per connection per day, whatever the cause. */
export const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const RECONNECT_PATH = "/onboarding?reconnect=1";

/**
 * - `refresh-rejected`: Plaud turned the refresh token down. The access token
 *   may still work for a few hours, so this arrives before recordings stop.
 * - `expired`: a sync failed on a dead credential; nothing is coming in.
 */
export type ConnectionProblem = "refresh-rejected" | "expired";

function formatDate(date: Date): string {
    return date.toLocaleString("nl-NL", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "Europe/Amsterdam",
    });
}

/** Subject and body for an alert. Pure, so the wording can be tested. */
export function buildAlertMessage(
    problem: ConnectionProblem,
    reconnectUrl: string,
    accessExpiresAt: Date | null,
    now: Date = new Date(),
): { subject: string; text: string; html: string } {
    const stillValid =
        problem === "refresh-rejected" &&
        accessExpiresAt !== null &&
        accessExpiresAt.getTime() > now.getTime();

    const subject = stillValid
        ? "Plaud-koppeling: automatisch vernieuwen is mislukt"
        : "Je Plaud-koppeling is verlopen";
    const lead = stillValid
        ? `OpenPlaud kon je Plaud-koppeling niet automatisch vernieuwen. De huidige token werkt nog tot ${formatDate(accessExpiresAt as Date)}; daarna komen er geen opnames en transcripties meer binnen.`
        : "Je Plaud-koppeling is verlopen en kon niet automatisch worden vernieuwd. Opnames en transcripties komen niet binnen.";
    const action = "Koppel opnieuw via";
    const footer = "Je krijgt hierover hooguit één mail per dag.";

    return {
        subject,
        text: `${lead}\n\n${action} ${reconnectUrl}\n\n${footer}`,
        html: `<p>${lead}</p><p>${action} <a href="${reconnectUrl}">${reconnectUrl}</a>.</p><p>${footer}</p>`,
    };
}

/**
 * Mail the owner of a connection that needs reconnecting, at most once per
 * {@link ALERT_COOLDOWN_MS}. Returns true when a mail went out.
 *
 * The cooldown is claimed with a conditional UPDATE, so the cron sync and a
 * browser-triggered sync failing in the same minute send one mail between
 * them. If sending fails the claim is released and the next run tries again.
 */
export async function alertConnectionProblem(
    connectionId: string,
    problem: ConnectionProblem,
): Promise<boolean> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - ALERT_COOLDOWN_MS);

    const [claimed] = await db
        .update(plaudConnections)
        .set({ lastAlertAt: now })
        .where(
            and(
                eq(plaudConnections.id, connectionId),
                or(
                    isNull(plaudConnections.lastAlertAt),
                    lt(plaudConnections.lastAlertAt, cutoff),
                ),
            ),
        )
        .returning({
            userId: plaudConnections.userId,
            accessExpiresAt: plaudConnections.accessExpiresAt,
        });
    if (!claimed) return false;

    const [settings] = await db
        .select({ notificationEmail: userSettings.notificationEmail })
        .from(userSettings)
        .where(eq(userSettings.userId, claimed.userId))
        .limit(1);
    const [user] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, claimed.userId))
        .limit(1);

    const to = settings?.notificationEmail || user?.email;
    const message = buildAlertMessage(
        problem,
        `${env.APP_URL ?? ""}${RECONNECT_PATH}`,
        claimed.accessExpiresAt,
        now,
    );
    const sent = to ? await sendEmail({ to, ...message }) : false;

    console.log(
        `[plaud-alert] connection=${connectionId} problem=${problem} sent=${sent}`,
    );

    if (!sent) {
        await db
            .update(plaudConnections)
            .set({ lastAlertAt: null })
            .where(
                and(
                    eq(plaudConnections.id, connectionId),
                    eq(plaudConnections.lastAlertAt, now),
                ),
            );
    }
    return sent;
}
