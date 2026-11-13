"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LEDIndicator } from "@/components/led-indicator";
import { MetalButton } from "@/components/metal-button";
import { Panel } from "@/components/panel";
import {
    PlaudConnectForm,
    PlaudTokenStatus,
    type PlaudTokenStatusData,
} from "@/components/plaud/plaud-connect-form";

type Step = "plaud" | "complete";

export function OnboardingForm() {
    const [step, setStep] = useState<Step>("plaud");
    const [status, setStatus] = useState<PlaudTokenStatusData | null>(null);
    const router = useRouter();

    return (
        <Panel className="w-full max-w-2xl space-y-6">
            {/* Progress indicator */}
            <div className="flex items-center justify-center gap-8">
                <div className="flex items-center gap-2">
                    <LEDIndicator active={step === "plaud"} status="active" />
                    <span className="text-sm">Plaud Setup</span>
                </div>
                <div className="flex items-center gap-2">
                    <LEDIndicator
                        active={step === "complete"}
                        status="active"
                    />
                    <span className="text-sm">Complete</span>
                </div>
            </div>

            {step === "plaud" && (
                <div className="space-y-4">
                    <div>
                        <h2 className="text-xl font-bold">
                            Connect Your Plaud Device
                        </h2>
                        <p className="text-sm text-muted-foreground mt-1">
                            Copy your session from web.plaud.ai
                        </p>
                    </div>

                    <PlaudConnectForm
                        onConnected={(result) => {
                            setStatus(result);
                            setStep("complete");
                        }}
                    />
                </div>
            )}

            {step === "complete" && (
                <div className="space-y-4 text-center">
                    <LEDIndicator
                        active
                        status="active"
                        size="lg"
                        pulse
                        className="mx-auto"
                    />
                    <div>
                        <h2 className="text-2xl font-bold">Setup Complete!</h2>
                        <p className="text-sm text-muted-foreground mt-1">
                            Your recordings will start syncing automatically
                        </p>
                    </div>
                    {status && (
                        <Panel variant="inset">
                            <PlaudTokenStatus status={status} />
                        </Panel>
                    )}
                    <MetalButton
                        onClick={() => router.push("/dashboard")}
                        variant="cyan"
                        className="w-full"
                    >
                        Go to Dashboard
                    </MetalButton>
                </div>
            )}
        </Panel>
    );
}
