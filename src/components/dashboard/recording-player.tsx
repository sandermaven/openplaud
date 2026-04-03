"use client";

import { Pause, Play, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MetalButton } from "@/components/metal-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import type { Recording } from "@/types/recording";

interface RecordingPlayerProps {
    recording: Recording;
    onEnded?: () => void;
}

const playbackSpeedOptions = [
    { label: "0.5x", value: 0.5 },
    { label: "0.75x", value: 0.75 },
    { label: "1x", value: 1.0 },
    { label: "1.25x", value: 1.25 },
    { label: "1.5x", value: 1.5 },
    { label: "2x", value: 2.0 },
];

export function RecordingPlayer({ recording, onEnded }: RecordingPlayerProps) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(75);
    const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
    const [autoPlayNext, setAutoPlayNext] = useState(false);
    const audioRef = useRef<HTMLAudioElement>(null);
    const isSeekingRef = useRef(false);
    const settingsLoadedRef = useRef(false);

    useEffect(() => {
        if (settingsLoadedRef.current) return;

        fetch("/api/settings/user")
            .then((res) => res.json())
            .then((data) => {
                if (data.defaultVolume !== undefined) {
                    setVolume(data.defaultVolume);
                }
                if (data.defaultPlaybackSpeed !== undefined) {
                    setPlaybackSpeed(data.defaultPlaybackSpeed);
                }
                if (data.autoPlayNext !== undefined) {
                    setAutoPlayNext(data.autoPlayNext);
                }
                settingsLoadedRef.current = true;
            })
            .catch(() => {
                settingsLoadedRef.current = true;
            });
    }, []);

    useEffect(() => {
        const recordingId = recording.id; // Explicitly use recording to satisfy linter
        setCurrentTime(0);
        setDuration(0);
        setIsPlaying(false);
        if (audioRef.current) {
            audioRef.current.currentTime = 0;
        }
        if (audioRef.current) {
            audioRef.current.src = `/api/recordings/${recordingId}/audio`;
            audioRef.current.load();
        }
    }, [recording]);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.volume = volume / 100;
        }
    }, [volume]);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.playbackRate = playbackSpeed;
        }
    }, [playbackSpeed]);

    useEffect(() => {
        if (!audioRef.current) return;

        const audio = audioRef.current;

        const updateTime = () => {
            if (!isSeekingRef.current) {
                setCurrentTime(audio.currentTime);
            }
        };
        const updateDuration = () => {
            if (audio.duration && !Number.isNaN(audio.duration)) {
                setDuration(audio.duration);
            }
        };
        const handleEnded = () => {
            setIsPlaying(false);
            if (autoPlayNext && onEnded) {
                onEnded();
            }
        };
        const handleSeeked = () => {
            isSeekingRef.current = false;
            setCurrentTime(audio.currentTime);
        };
        const handleError = () => {
            setIsPlaying(false);
            const err = audio.error;
            console.error("Audio load error:", err?.code, err?.message);
            toast.error("Failed to load audio");
        };

        audio.addEventListener("timeupdate", updateTime);
        audio.addEventListener("loadedmetadata", updateDuration);
        audio.addEventListener("durationchange", updateDuration);
        audio.addEventListener("ended", handleEnded);
        audio.addEventListener("seeked", handleSeeked);
        audio.addEventListener("error", handleError);

        if (audio.duration && !Number.isNaN(audio.duration)) {
            setDuration(audio.duration);
        }

        return () => {
            audio.removeEventListener("timeupdate", updateTime);
            audio.removeEventListener("loadedmetadata", updateDuration);
            audio.removeEventListener("durationchange", updateDuration);
            audio.removeEventListener("ended", handleEnded);
            audio.removeEventListener("seeked", handleSeeked);
            audio.removeEventListener("error", handleError);
        };
    }, [recording, autoPlayNext, onEnded]);

    const togglePlayPause = useCallback(() => {
        if (!audioRef.current) return;

        if (isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            audioRef.current.playbackRate = playbackSpeed;
            audioRef.current
                .play()
                .then(() => {
                    setIsPlaying(true);
                })
                .catch((error) => {
                    console.error("Error playing audio:", error);
                    setIsPlaying(false);
                    toast.error("Failed to play audio");
                });
        }
    }, [isPlaying, playbackSpeed]);

    const handleSeek = (value: number[]) => {
        const audio = audioRef.current;
        if (!audio) return;

        const percentage = value[0];

        const audioDuration = audio.duration;
        if (!audioDuration || Number.isNaN(audioDuration)) {
            audio.load();
            return;
        }

        const newTime = (percentage / 100) * audioDuration;

        isSeekingRef.current = true;

        audio.currentTime = newTime;

        setCurrentTime(newTime);
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (
                target.tagName === "INPUT" ||
                target.tagName === "TEXTAREA" ||
                target.isContentEditable
            ) {
                return;
            }

            switch (e.key) {
                case " ": {
                    e.preventDefault();
                    togglePlayPause();
                    break;
                }
                case "ArrowLeft": {
                    e.preventDefault();
                    if (audioRef.current && duration > 0) {
                        const newTime = Math.max(0, currentTime - 5);
                        audioRef.current.currentTime = newTime;
                        setCurrentTime(newTime);
                    }
                    break;
                }
                case "ArrowRight": {
                    e.preventDefault();
                    if (audioRef.current && duration > 0) {
                        const newTime = Math.min(duration, currentTime + 5);
                        audioRef.current.currentTime = newTime;
                        setCurrentTime(newTime);
                    }
                    break;
                }
                case "ArrowUp": {
                    e.preventDefault();
                    setVolume((prev) => Math.min(100, prev + 5));
                    break;
                }
                case "ArrowDown": {
                    e.preventDefault();
                    setVolume((prev) => Math.max(0, prev - 5));
                    break;
                }
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [currentTime, duration, togglePlayPause]);

    const formatTime = (seconds: number) => {
        if (!seconds || Number.isNaN(seconds)) return "0:00";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    return (
        <Card>
            <CardHeader>
                <CardTitle>{recording.filename}</CardTitle>
                <p className="text-sm text-muted-foreground">
                    {new Date(recording.startTime).toLocaleString()}
                </p>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex items-center gap-4">
                    <Button
                        onClick={togglePlayPause}
                        size="lg"
                        className="w-12 h-12 rounded-full"
                    >
                        {isPlaying ? (
                            <Pause className="w-5 h-5" />
                        ) : (
                            <Play className="w-5 h-5" />
                        )}
                    </Button>

                    <div className="flex-1 space-y-2">
                        <Slider
                            value={[progress]}
                            onValueChange={handleSeek}
                            onValueCommit={handleSeek}
                            max={100}
                            step={0.1}
                            className="w-full"
                            disabled={!duration || duration === 0}
                        />
                        <div className="flex justify-between text-xs text-muted-foreground">
                            <span>{formatTime(currentTime)}</span>
                            <span>{formatTime(duration)}</span>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <MetalButton
                            onClick={() => {
                                const currentIndex =
                                    playbackSpeedOptions.findIndex(
                                        (opt) => opt.value === playbackSpeed,
                                    );
                                const nextIndex =
                                    (currentIndex + 1) %
                                    playbackSpeedOptions.length;
                                const nextSpeed =
                                    playbackSpeedOptions[nextIndex].value;
                                setPlaybackSpeed(nextSpeed);
                                if (audioRef.current) {
                                    audioRef.current.playbackRate = nextSpeed;
                                }
                            }}
                            variant="default"
                            size="sm"
                            className="w-12 h-8 font-mono text-xs px-2"
                            title="Click to cycle playback speed"
                        >
                            {playbackSpeedOptions.find(
                                (opt) => opt.value === playbackSpeed,
                            )?.label || "1x"}
                        </MetalButton>

                        <div className="flex items-center gap-2 w-32">
                            <Volume2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            <Slider
                                value={[volume]}
                                onValueChange={(value) =>
                                    setVolume(value[0] ?? 75)
                                }
                                max={100}
                                className="flex-1"
                            />
                        </div>
                    </div>
                </div>

                <audio
                    ref={audioRef}
                    src={`/api/recordings/${recording.id}/audio`}
                    preload="metadata"
                    className="hidden"
                >
                    <track kind="captions" />
                </audio>
            </CardContent>
        </Card>
    );
}
