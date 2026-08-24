import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { OnboardingForm } from "@/components/onboarding/onboarding-form";
import { db } from "@/db";
import { plaudConnections } from "@/db/schema";
import { requireAuth } from "@/lib/auth-server";

export default async function OnboardingPage({
    searchParams,
}: {
    searchParams: Promise<{ reconnect?: string }>;
}) {
    // Check authentication server-side
    const session = await requireAuth();

    const { reconnect } = await searchParams;
    const isReconnect = reconnect === "1";

    // Check if user already has a Plaud connection
    const [existingConnection] = await db
        .select()
        .from(plaudConnections)
        .where(eq(plaudConnections.userId, session.user.id))
        .limit(1);

    // If already connected, redirect to dashboard — unless the user explicitly
    // asked to reconnect (e.g. after an expired token), in which case we show
    // the form so they can enter a fresh bearer token.
    if (existingConnection && !isReconnect) {
        redirect("/dashboard");
    }

    return (
        <div className="flex min-h-full items-center justify-center p-4">
            <OnboardingForm />
        </div>
    );
}
