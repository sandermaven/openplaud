"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    COPY_BEARER_COMMAND,
    COPY_REFRESH_COMMAND,
    COPY_SESSION_COMMAND,
    PLAUD_WEB_URL,
} from "@/lib/plaud/connect-commands";
import { PLAUD_SERVERS, type PlaudServerKey } from "@/lib/plaud/servers";
import {
    describeTokens,
    type ParsedPlaudCredentials,
    parseSessionTokens,
} from "@/lib/plaud/token-info";

/** What the connect and connection endpoints report about the stored tokens. */
export interface PlaudTokenStatusData {
    apiBase?: string | null;
    accessExpiresAt?: string | Date | null;
    refreshExpiresAt?: string | Date | null;
    hasRefreshToken?: boolean;
    refreshError?: string | null;
}

type ServerChoice = "auto" | PlaudServerKey;

const SERVER_ENTRIES = Object.entries(PLAUD_SERVERS) as [
    PlaudServerKey,
    (typeof PLAUD_SERVERS)[PlaudServerKey],
][];

function formatDate(value: string | Date | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString("nl-NL", {
        dateStyle: "long",
        timeStyle: "short",
    });
}

function serverLabel(apiBase: string | null | undefined): string | null {
    if (!apiBase) return null;
    const known = SERVER_ENTRIES.find(([, s]) => s.apiBase === apiBase);
    return known ? known[1].label : apiBase;
}

/**
 * A Console command the user copies verbatim.
 *
 * Rendered in <pre><code> from a string constant, with translation and
 * ligatures off, so the straight quotes reach the clipboard as straight
 * quotes. The button copies the constant itself, not the rendered text.
 */
function CommandBlock({ command }: { command: string }) {
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            toast.error(
                "Kopiëren lukt niet in deze browser. Selecteer het commando en kopieer het handmatig.",
            );
        }
    };

    return (
        <div className="flex items-start gap-2">
            <pre
                translate="no"
                spellCheck={false}
                className="notranslate min-w-0 flex-1 select-all whitespace-pre-wrap break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs"
                style={{
                    fontVariantLigatures: "none",
                    fontFeatureSettings: '"liga" 0, "clig" 0',
                }}
            >
                <code>{command}</code>
            </pre>
            <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={copy}
                className="shrink-0"
                aria-label="Kopieer commando"
            >
                {copied ? (
                    <Check className="h-4 w-4" />
                ) : (
                    <Copy className="h-4 w-4" />
                )}
                {copied ? "Gekopieerd" : "Kopieer"}
            </Button>
        </div>
    );
}

/** When the stored bearer and refresh token expire, and on which server. */
export function PlaudTokenStatus({ status }: { status: PlaudTokenStatusData }) {
    const access = formatDate(status.accessExpiresAt);
    const refresh = formatDate(status.refreshExpiresAt);
    const server = serverLabel(status.apiBase);

    return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-left text-sm">
            {server && (
                <>
                    <dt className="text-muted-foreground">API-server</dt>
                    <dd>{server}</dd>
                </>
            )}
            <dt className="text-muted-foreground">Bearer token verloopt</dt>
            <dd>{access ?? "onbekend"}</dd>
            <dt className="text-muted-foreground">Refresh token verloopt</dt>
            <dd>
                {status.hasRefreshToken
                    ? (refresh ?? "onbekend")
                    : "geen refresh token opgeslagen"}
            </dd>
            <dt className="text-muted-foreground">Vernieuwen</dt>
            <dd>
                {status.refreshError
                    ? "laatste poging mislukt; koppel opnieuw"
                    : status.hasRefreshToken
                      ? "automatisch, vóór de bearer token verloopt"
                      : "niet mogelijk; koppel opnieuw zodra de bearer token verloopt"}
            </dd>
        </dl>
    );
}

interface PlaudConnectFormProps {
    onConnected: (status: PlaudTokenStatusData) => void;
}

/**
 * The instructions and inputs for (re)connecting a Plaud account, shared by
 * the onboarding page and the onboarding dialog.
 */
export function PlaudConnectForm({ onConnected }: PlaudConnectFormProps) {
    const [session, setSession] = useState("");
    const [bearerToken, setBearerToken] = useState("");
    const [refreshToken, setRefreshToken] = useState("");
    const [server, setServer] = useState<ServerChoice>("auto");
    const [isLoading, setIsLoading] = useState(false);

    const sessionParsed = useMemo(
        () => (session.trim() ? parseSessionTokens(session) : null),
        [session],
    );
    const sessionInvalid = session.trim() !== "" && !sessionParsed;

    // The pasted session wins; the separate fields are the fallback.
    const parsed: ParsedPlaudCredentials | null = useMemo(
        () =>
            sessionParsed ??
            (bearerToken.trim()
                ? describeTokens(bearerToken, refreshToken)
                : null),
        [sessionParsed, bearerToken, refreshToken],
    );

    const detectedServer = parsed?.serverKey ?? null;

    const handleConnect = async () => {
        if (!parsed) {
            toast.error(
                sessionInvalid
                    ? "De geplakte tekst is niet de waarde van pld_session.tokens."
                    : "Plak eerst de sessie of een bearer token.",
            );
            return;
        }

        setIsLoading(true);
        try {
            const response = await fetch("/api/plaud/connect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...(sessionParsed
                        ? { sessionTokens: session }
                        : {
                              bearerToken,
                              refreshToken: refreshToken.trim() || undefined,
                          }),
                    server,
                }),
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || "Failed to connect");
            }

            toast.success("Plaud device connected");
            setSession("");
            setBearerToken("");
            setRefreshToken("");
            onConnected(data as PlaudTokenStatusData);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to connect to Plaud",
            );
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="space-y-5 text-sm">
            <ol className="space-y-4">
                <li className="space-y-2">
                    <p className="font-medium">1. Open Plaud in je browser</p>
                    <Button asChild variant="outline" size="sm">
                        <a
                            href={PLAUD_WEB_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Open web.plaud.ai
                            <ExternalLink className="h-4 w-4" />
                        </a>
                    </Button>
                    <p className="text-muted-foreground">
                        Je moet daar ingelogd zijn. Doe dit bij voorkeur in een
                        privévenster en sluit dat daarna zonder uit te loggen:
                        OpenPlaud krijgt dan een eigen sessie, los van je gewone
                        browser.
                    </p>
                </li>

                <li className="space-y-1">
                    <p className="font-medium">2. Open de Console</p>
                    <p className="text-muted-foreground">
                        <kbd className="font-mono">Cmd+Option+J</kbd> (Mac) of{" "}
                        <kbd className="font-mono">Ctrl+Shift+J</kbd> (Windows).
                    </p>
                </li>

                <li className="space-y-2">
                    <p className="font-medium">
                        3. Plak dit commando in de Console en druk op Enter
                    </p>
                    <CommandBlock command={COPY_SESSION_COMMAND} />
                    <p className="text-muted-foreground">
                        De Console toont daarna{" "}
                        <code className="font-mono">undefined</code>. Dat hoort
                        zo: de waarde staat dan op je klembord. Weigert Chrome
                        het plakken, typ dan eerst{" "}
                        <code className="font-mono">allow pasting</code> en druk
                        op Enter.
                    </p>
                </li>

                <li className="space-y-2">
                    <Label htmlFor="plaud-session" className="font-medium">
                        4. Plak het resultaat hier
                    </Label>
                    <Input
                        id="plaud-session"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder='{"epoch": "...", "byWsId": {...}}'
                        value={session}
                        onChange={(e) => setSession(e.target.value)}
                        disabled={isLoading}
                        className="font-mono"
                    />
                    {sessionInvalid && (
                        <p className="text-destructive">
                            Dit is niet de waarde van{" "}
                            <code className="font-mono">
                                pld_session.tokens
                            </code>
                            . Voer het commando uit stap 3 opnieuw uit en plak
                            het resultaat ongewijzigd.
                        </p>
                    )}
                    <p className="text-muted-foreground">
                        OpenPlaud haalt hier zelf de bearer token, de refresh
                        token en de vervaldatums uit.
                    </p>
                </li>
            </ol>

            <details className="rounded-md border px-3 py-2">
                <summary className="cursor-pointer font-medium">
                    Lukt dat niet? Voer de tokens los in
                </summary>
                <div className="mt-3 space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="plaud-bearer">Bearer token</Label>
                        <CommandBlock command={COPY_BEARER_COMMAND} />
                        <Input
                            id="plaud-bearer"
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="Bearer eyJ..."
                            value={bearerToken}
                            onChange={(e) => setBearerToken(e.target.value)}
                            disabled={isLoading || !!sessionParsed}
                            className="font-mono"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="plaud-refresh">Refresh token</Label>
                        <CommandBlock command={COPY_REFRESH_COMMAND} />
                        <Input
                            id="plaud-refresh"
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="eyJ..."
                            value={refreshToken}
                            onChange={(e) => setRefreshToken(e.target.value)}
                            disabled={isLoading || !!sessionParsed}
                            className="font-mono"
                        />
                        <p className="text-muted-foreground">
                            Ook hier toont de Console{" "}
                            <code className="font-mono">undefined</code> en
                            staat de waarde op je klembord. Zonder refresh token
                            verloopt de koppeling na 24 uur.
                        </p>
                    </div>
                </div>
            </details>

            {parsed && (
                <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
                    <p className="font-medium">Herkend</p>
                    <PlaudTokenStatus
                        status={{
                            accessExpiresAt: parsed.accessExpiresAt,
                            refreshExpiresAt: parsed.refreshExpiresAt,
                            hasRefreshToken: !!parsed.refreshToken,
                        }}
                    />
                    {parsed.workspaceCount > 1 && (
                        <p className="text-muted-foreground">
                            De sessie bevat {parsed.workspaceCount} workspaces;
                            de eerste ({parsed.workspaceId}) wordt gekoppeld.
                        </p>
                    )}
                </div>
            )}

            <div className="space-y-2">
                <Label htmlFor="plaud-server">API-server</Label>
                <Select
                    value={server}
                    onValueChange={(v) => setServer(v as ServerChoice)}
                >
                    <SelectTrigger id="plaud-server" disabled={isLoading}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[200]">
                        <SelectItem value="auto">
                            Automatisch (uit de token)
                        </SelectItem>
                        {SERVER_ENTRIES.map(([key, s]) => (
                            <SelectItem key={key} value={key}>
                                {s.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                    {server !== "auto"
                        ? `Handmatig gekozen: ${PLAUD_SERVERS[server].label}.`
                        : detectedServer
                          ? `Regio ${parsed?.region} in de token: ${PLAUD_SERVERS[detectedServer].label}.`
                          : parsed?.region
                            ? `Regio ${parsed.region} is onbekend. OpenPlaud begint bij Global en volgt de doorverwijzing van Plaud; kies hier zelf een server als dat misgaat.`
                            : "De server wordt gekozen op basis van de regio in de token."}
                </p>
            </div>

            <Button
                type="button"
                onClick={handleConnect}
                disabled={isLoading || !parsed}
                className="w-full"
            >
                {isLoading ? "Connecting..." : "Connect Device"}
            </Button>
        </div>
    );
}
