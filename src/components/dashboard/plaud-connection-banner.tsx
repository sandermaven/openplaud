"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Shows a red banner when the user's Plaud connection has an unresolved sync
 * error (e.g. an expired bearer token). Reconnecting is the only fix, so it
 * links to the onboarding form in reconnect mode.
 */
export function PlaudConnectionBanner() {
    const [syncError, setSyncError] = useState<string | null>(null);

    useEffect(() => {
        fetch("/api/plaud/connection")
            .then((res) => res.json())
            .then((data) => {
                if (data.syncError) setSyncError(data.syncError as string);
            })
            .catch(() => {});
    }, []);

    if (!syncError) return null;

    return (
        <div className="mb-6 flex flex-col gap-3 rounded-lg border border-red-500/50 bg-red-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
                <div>
                    <p className="font-medium text-red-700 dark:text-red-300">
                        Je Plaud-koppeling is verlopen
                    </p>
                    <p className="text-sm text-red-700/80 dark:text-red-300/80">
                        Transcripties komen niet binnen. Koppel je Plaud-account
                        opnieuw om het herstellen.
                    </p>
                </div>
            </div>
            <Button asChild variant="outline" size="sm" className="shrink-0">
                <Link href="/onboarding?reconnect=1">
                    Plaud opnieuw koppelen
                </Link>
            </Button>
        </div>
    );
}
