"use client";

import { BookOpen, Check, Eye, EyeOff, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useSettings } from "@/hooks/use-settings";

const LANGUAGES = [
    { value: "nl", label: "Nederlands" },
    { value: "en", label: "English" },
    { value: "de", label: "Deutsch" },
    { value: "fr", label: "Fran\u00e7ais" },
    { value: "es", label: "Espa\u00f1ol" },
    { value: "pt", label: "Portugu\u00eas" },
];

const DEFAULT_SUMMARY_PROMPT = `Vat deze transcriptie samen in de volgende structuur:

**Kern** (1-2 zinnen: waar ging het over?)
**Beslissingen** (wat is er besloten?)
**Actiepunten** (wie doet wat, eventueel met deadline)
**Opvallend** (context, spanningen, open vragen — alleen als relevant)

Wees bondig. Laat secties weg als ze leeg zijn.`;

interface NotionConfig {
    id?: string;
    databaseId: string;
    enabled: boolean;
    autoSave: boolean;
    defaultTags: string[];
    includeActionItems: boolean;
    includeSummary: boolean;
    language: string;
    summaryPrompt: string | null;
    maskedToken: string;
    source?: "db" | "env";
}

export function NotionSection() {
    const {
        isLoadingSettings,
        setIsLoadingSettings,
        isSavingSettings,
    } = useSettings();

    const [config, setConfig] = useState<NotionConfig | null>(null);
    const [token, setToken] = useState("");
    const [databaseId, setDatabaseId] = useState("");

    // Extract database ID from full Notion URL or raw ID
    const parseDatabaseId = (input: string): string => {
        const trimmed = input.trim();
        // Match 32-char hex ID from URL like https://www.notion.so/workspace/9ac49c1f8ea84c42a8d41185d4bf86fe?v=...
        const urlMatch = trimmed.match(
            /([0-9a-f]{32})(?:\?|$)/i,
        );
        if (urlMatch) return urlMatch[1];
        // Match UUID format (with dashes)
        const uuidMatch = trimmed.match(
            /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
        );
        if (uuidMatch) return uuidMatch[1];
        return trimmed;
    };
    const [enabled, setEnabled] = useState(true);
    const [autoSave, setAutoSave] = useState(true);
    const [defaultTags, setDefaultTags] = useState("Knowledge");
    const [includeActionItems, setIncludeActionItems] = useState(true);
    const [includeSummary, setIncludeSummary] = useState(true);
    const [language, setLanguage] = useState("nl");
    const [summaryPrompt, setSummaryPrompt] = useState(DEFAULT_SUMMARY_PROMPT);
    const [showToken, setShowToken] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isVerifying, setIsVerifying] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [verifyResult, setVerifyResult] = useState<{
        type: "success" | "error" | null;
        message: string;
    }>({ type: null, message: "" });
    const [saveMessage, setSaveMessage] = useState<{
        type: "success" | "error" | null;
        message: string;
    }>({ type: null, message: "" });

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const response = await fetch("/api/settings/notion");
                if (response.ok) {
                    const data = await response.json();
                    if (data.config) {
                        setConfig(data.config);
                        setDatabaseId(data.config.databaseId);
                        setEnabled(data.config.enabled);
                        setAutoSave(data.config.autoSave);
                        setDefaultTags(
                            (data.config.defaultTags || ["Knowledge"]).join(
                                ", ",
                            ),
                        );
                        setIncludeActionItems(data.config.includeActionItems);
                        setIncludeSummary(data.config.includeSummary);
                        setLanguage(data.config.language);
                        setSummaryPrompt(data.config.summaryPrompt || DEFAULT_SUMMARY_PROMPT);
                    }
                }
            } catch (err) {
                console.error("Failed to fetch Notion config:", err);
            } finally {
                setIsLoadingSettings(false);
            }
        };
        fetchConfig();
    }, [setIsLoadingSettings]);

    const handleVerify = async () => {
        const testToken = token || undefined;
        const testDbId = databaseId;

        if (!testToken && !config) {
            setVerifyResult({
                type: "error",
                message: "Please enter an integration token first",
            });
            return;
        }

        if (!testDbId && !config) {
            setVerifyResult({
                type: "error",
                message: "Please enter a database ID first",
            });
            return;
        }

        setIsVerifying(true);
        setVerifyResult({ type: null, message: "" });

        try {
            const response = await fetch("/api/settings/notion/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    token: testToken,
                    databaseId: testDbId || undefined,
                    useSaved: !testToken || !testDbId,
                }),
            });

            const data = await response.json();

            if (data.success) {
                setVerifyResult({
                    type: "success",
                    message: `Connected to "${data.databaseTitle}"`,
                });
            } else {
                setVerifyResult({
                    type: "error",
                    message: data.error || "Connection failed",
                });
            }
        } catch {
            setVerifyResult({
                type: "error",
                message: "Failed to verify connection",
            });
        } finally {
            setIsVerifying(false);
        }
    };

    const handleSave = async () => {
        if (!databaseId) {
            setSaveMessage({
                type: "error",
                message: "Database ID is required",
            });
            return;
        }
        if (!token && !config) {
            setSaveMessage({
                type: "error",
                message: "Integration token is required",
            });
            return;
        }

        setIsSaving(true);
        setSaveMessage({ type: null, message: "" });

        try {
            const tags = defaultTags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean);

            const body: Record<string, unknown> = {
                databaseId,
                enabled,
                autoSave,
                defaultTags: tags,
                includeActionItems,
                includeSummary,
                language,
                summaryPrompt: summaryPrompt || null,
            };

            if (token) {
                body.token = token;
            }

            const response = await fetch("/api/settings/notion", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (response.ok) {
                setSaveMessage({
                    type: "success",
                    message: "Notion configuration saved",
                });
                setToken("");
                // Refresh config
                const refreshResponse = await fetch("/api/settings/notion");
                if (refreshResponse.ok) {
                    const data = await refreshResponse.json();
                    if (data.config) setConfig(data.config);
                }
            } else {
                const data = await response.json();
                setSaveMessage({
                    type: "error",
                    message: data.error || "Failed to save",
                });
            }
        } catch {
            setSaveMessage({
                type: "error",
                message: "Failed to save configuration",
            });
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async () => {
        setIsDeleting(true);
        try {
            const response = await fetch("/api/settings/notion", {
                method: "DELETE",
            });
            if (response.ok) {
                setConfig(null);
                setToken("");
                setDatabaseId("");
                setEnabled(true);
                setAutoSave(true);
                setDefaultTags("Knowledge");
                setIncludeActionItems(true);
                setIncludeSummary(true);
                setSummaryPrompt(DEFAULT_SUMMARY_PROMPT);
                setLanguage("nl");
                setSaveMessage({
                    type: "success",
                    message: "Notion configuration removed",
                });
            }
        } catch {
            setSaveMessage({
                type: "error",
                message: "Failed to remove configuration",
            });
        } finally {
            setIsDeleting(false);
        }
    };

    if (isLoadingSettings) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <h2 className="text-lg font-semibold flex items-center gap-2">
                <BookOpen className="w-5 h-5" />
                Notion Integration
            </h2>

            {config?.source === "env" && (
                <p className="text-xs text-muted-foreground bg-muted px-3 py-2 rounded-md">
                    Using environment variables (NOTION_TOKEN, NOTION_DATABASE_ID). Save via the UI to override.
                </p>
            )}

            <div className="space-y-4">
                {/* Integration Token */}
                <div className="space-y-2">
                    <Label htmlFor="notion-token">Integration Token</Label>
                    <div className="relative">
                        <Input
                            id="notion-token"
                            type={showToken ? "text" : "password"}
                            value={token}
                            onChange={(e) => setToken(e.target.value)}
                            placeholder={
                                config
                                    ? config.maskedToken
                                    : "ntn_xxxxxxxxxxxxxxxxxxxx"
                            }
                            className="pr-10"
                        />
                        <button
                            type="button"
                            onClick={() => setShowToken(!showToken)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                            {showToken ? (
                                <EyeOff className="w-4 h-4" />
                            ) : (
                                <Eye className="w-4 h-4" />
                            )}
                        </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Create an integration at notion.so/my-integrations and
                        share your database with it
                    </p>
                </div>

                {/* Database ID */}
                <div className="space-y-2">
                    <Label htmlFor="notion-database-id">Database ID</Label>
                    <Input
                        id="notion-database-id"
                        type="text"
                        value={databaseId}
                        onChange={(e) =>
                            setDatabaseId(parseDatabaseId(e.target.value))
                        }
                        placeholder="Paste database URL or ID"
                    />
                    <p className="text-xs text-muted-foreground">
                        Paste the full Notion database URL or just the ID
                    </p>
                </div>

                {/* Test Connection */}
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleVerify}
                        disabled={isVerifying}
                    >
                        {isVerifying ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Verifying...
                            </>
                        ) : (
                            "Test Connection"
                        )}
                    </Button>
                    {verifyResult.type && (
                        <span
                            className={`text-xs flex items-center gap-1 ${
                                verifyResult.type === "success"
                                    ? "text-green-600 dark:text-green-400"
                                    : "text-red-600 dark:text-red-400"
                            }`}
                        >
                            {verifyResult.type === "success" ? (
                                <Check className="w-3 h-3" />
                            ) : (
                                <X className="w-3 h-3" />
                            )}
                            {verifyResult.message}
                        </span>
                    )}
                </div>

                {/* Divider */}
                <div className="border-t pt-4" />

                {/* Auto-save toggle */}
                <div className="flex items-center justify-between">
                    <div className="space-y-0.5 flex-1">
                        <Label htmlFor="notion-autosave" className="text-base">
                            Auto-save to Notion
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            Automatically save transcriptions to Notion after
                            processing
                        </p>
                    </div>
                    <Switch
                        id="notion-autosave"
                        checked={autoSave}
                        onCheckedChange={setAutoSave}
                        disabled={isSavingSettings}
                    />
                </div>

                {/* Default Tags */}
                <div className="space-y-2">
                    <Label htmlFor="notion-tags">Default Tags</Label>
                    <Input
                        id="notion-tags"
                        type="text"
                        value={defaultTags}
                        onChange={(e) => setDefaultTags(e.target.value)}
                        placeholder="Knowledge, Meeting"
                    />
                    <p className="text-xs text-muted-foreground">
                        Comma-separated tags to add to new Notion pages
                    </p>
                </div>

                {/* Include Summary */}
                <div className="flex items-center justify-between">
                    <div className="space-y-0.5 flex-1">
                        <Label
                            htmlFor="notion-include-summary"
                            className="text-base"
                        >
                            Include summary
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            Add AI-generated summary to Notion pages
                        </p>
                    </div>
                    <Switch
                        id="notion-include-summary"
                        checked={includeSummary}
                        onCheckedChange={setIncludeSummary}
                        disabled={isSavingSettings}
                    />
                </div>

                {/* Summary Prompt */}
                {includeSummary && (
                    <div className="space-y-2 pl-1">
                        <Label htmlFor="notion-summary-prompt">
                            Samenvatting prompt
                        </Label>
                        <Textarea
                            id="notion-summary-prompt"
                            value={summaryPrompt}
                            onChange={(e) => setSummaryPrompt(e.target.value)}
                            placeholder={DEFAULT_SUMMARY_PROMPT}
                            rows={8}
                            className="font-mono text-xs"
                        />
                        <p className="text-xs text-muted-foreground">
                            De prompt waarmee de AI een samenvatting genereert
                            boven de transcriptie in Notion
                        </p>
                    </div>
                )}

                {/* Include Action Items */}
                <div className="flex items-center justify-between">
                    <div className="space-y-0.5 flex-1">
                        <Label
                            htmlFor="notion-include-action-items"
                            className="text-base"
                        >
                            Include action items
                        </Label>
                        <p className="text-sm text-muted-foreground">
                            Add action items as to-do blocks in Notion
                        </p>
                    </div>
                    <Switch
                        id="notion-include-action-items"
                        checked={includeActionItems}
                        onCheckedChange={setIncludeActionItems}
                        disabled={isSavingSettings}
                    />
                </div>

                {/* Content Language */}
                <div className="space-y-2">
                    <Label htmlFor="notion-language">Content Language</Label>
                    <Select value={language} onValueChange={setLanguage}>
                        <SelectTrigger className="w-[200px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {LANGUAGES.map((lang) => (
                                <SelectItem key={lang.value} value={lang.value}>
                                    {lang.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        Language used for section headings in Notion
                    </p>
                </div>

                {/* Divider */}
                <div className="border-t pt-4" />

                {/* Save / Delete buttons */}
                <div className="flex items-center gap-2">
                    <Button
                        onClick={handleSave}
                        disabled={isSaving}
                        size="sm"
                    >
                        {isSaving ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Saving...
                            </>
                        ) : (
                            "Save Configuration"
                        )}
                    </Button>
                    {config && (
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleDelete}
                            disabled={isDeleting}
                        >
                            {isDeleting ? "Removing..." : "Remove"}
                        </Button>
                    )}
                    {saveMessage.type && (
                        <span
                            className={`text-xs ${
                                saveMessage.type === "success"
                                    ? "text-green-600 dark:text-green-400"
                                    : "text-red-600 dark:text-red-400"
                            }`}
                        >
                            {saveMessage.message}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
