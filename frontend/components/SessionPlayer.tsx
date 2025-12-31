'use client';

import React, { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, AlertTriangle, MessageSquare } from 'lucide-react';

type TranscriptEvent = {
    role: 'user' | 'assistant';
    text: string;
    timestamp: number; // Relative seconds
};

type LatencyEvent = {
    event: string;
    turn: number;
    latency_ms: number;
};

type FreezeRegion = {
    start: number;
    end: number;
    duration: number;
    type: 'injected' | 'detected';
};

export default function SessionPlayer() {
    const containerRef = useRef<HTMLDivElement>(null);
    const wavesurfer = useRef<WaveSurfer | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [freezeRegions, setFreezeRegions] = useState<FreezeRegion[]>([]);
    const [latencies, setLatencies] = useState<LatencyEvent[]>([]);
    const [transcripts, setTranscripts] = useState<TranscriptEvent[]>([]);
    const [error, setError] = useState<string | null>(null);

    // Fetch events and calculate regions
    useEffect(() => {
        async function fetchEvents() {
            try {
                const res = await fetch('/api/session/events');
                const data: any[] = await res.json();

                if (!Array.isArray(data)) return;

                const startEvent = data.find(e => e.event === 'session_start');
                if (!startEvent) return;
                const startTime = new Date(startEvent.timestamp).getTime();

                // 1. Process Latencies
                setLatencies(data.filter(e => e.event === 'latency'));

                // 2. Process Freeze Regions
                const regions: FreezeRegion[] = [];
                let currentFreezeStart: number | null = null;
                data.forEach(e => {
                    const time = new Date(e.timestamp).getTime();
                    const relativeTime = (time - startTime) / 1000;

                    if (e.event === 'freeze_injected') {
                        currentFreezeStart = relativeTime;
                    } else if (e.event === 'freeze_end' && currentFreezeStart !== null) {
                        regions.push({ start: currentFreezeStart, end: relativeTime, duration: relativeTime - currentFreezeStart, type: 'injected' });
                        currentFreezeStart = null;
                    } else if (e.event === 'freeze_detected') {
                        regions.push({ start: relativeTime, end: relativeTime + 0.5, duration: 0.5, type: 'detected' });
                    }
                });
                setFreezeRegions(regions);

                // 3. Process Transcripts
                const transcriptData = data
                    .filter(e => e.event === 'transcript')
                    .map(e => ({
                        role: e.role,
                        text: e.text,
                        timestamp: (new Date(e.timestamp).getTime() - startTime) / 1000
                    }));
                setTranscripts(transcriptData);

            } catch (e) {
                console.error("Failed to fetch events", e);
            }
        }
        fetchEvents();
    }, []);

    // Initialize WaveSurfer
    useEffect(() => {
        if (!containerRef.current) return;
        const ws = WaveSurfer.create({
            container: containerRef.current,
            waveColor: '#4f46e5',
            progressColor: '#818cf8',
            cursorColor: '#c7d2fe',
            barWidth: 2,
            height: 96,
            url: '/api/session/audio',
        });
        ws.on('ready', () => setDuration(ws.getDuration()));
        ws.on('audioprocess', () => setCurrentTime(ws.getCurrentTime()));
        ws.on('finish', () => setIsPlaying(false));
        ws.on('error', () => setError("Failed to load audio."));
        wavesurfer.current = ws;
        return () => ws.destroy();
    }, []);

    const togglePlay = () => {
        if (wavesurfer.current) {
            wavesurfer.current.playPause();
            setIsPlaying(!isPlaying);
        }
    };

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 w-full max-w-6xl mx-auto">
            {/* Left Column: Player & Metrics */}
            <div className="lg:col-span-2 space-y-6">
                <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-xl font-bold text-gray-800">Session Playback</h2>
                        <div className="flex gap-2 text-sm">
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500"></span> Freeze</span>
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500"></span> Detected</span>
                        </div>
                    </div>

                    <div className="relative">
                        <div ref={containerRef} className="w-full h-24 bg-gray-50 rounded-lg overflow-hidden relative cursor-pointer" />

                        {/* Freeze Overlays */}
                        {duration > 0 && freezeRegions.map((region, idx) => (
                            <div key={idx}
                                className={`absolute top-0 h-24 pointer-events-none border-l border-r ${region.type === 'detected' ? 'bg-yellow-500/40 border-yellow-600' : 'bg-red-500/20 border-red-500'}`}
                                style={{ left: `${(region.start / duration) * 100}%`, width: `${Math.max((region.duration / duration) * 100, 0.5)}%` }}
                            />
                        ))}

                        {/* Blinking Alert Badge */}
                        {freezeRegions.some(r => r.type === 'detected' && currentTime >= r.start && currentTime <= (r.start + Math.max(r.duration, 3.0))) && (
                            <div className="absolute top-2 right-2 z-10 animate-pulse bg-red-600 text-white px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2 shadow-lg border border-red-400">
                                <AlertTriangle size={14} />
                                FREEZE DETECTED
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-4 mt-4">
                        <button onClick={togglePlay} className="w-12 h-12 flex items-center justify-center bg-indigo-600 text-white rounded-full hover:bg-indigo-700 transition">
                            {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" ml-1 />}
                        </button>
                        <div className="font-mono text-gray-600">{formatTime(currentTime)} / {formatTime(duration)}</div>
                    </div>
                </div>

                {/* Metrics */}
                <div className="space-y-6">
                    {/* Latency Cards */}
                    <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100">
                        <h3 className="font-semibold text-gray-800 mb-4">Turn Latency</h3>
                        <div className="grid grid-cols-4 gap-3">
                            {latencies.map((l, i) => (
                                <div key={i} className="bg-gray-50 p-2 rounded border border-gray-200 text-center">
                                    <div className="text-xs text-gray-500 uppercase">Turn {l.turn}</div>
                                    <div className="text-lg font-mono font-medium text-indigo-600">{l.latency_ms.toFixed(2)}ms</div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Freeze Analysis Cards */}
                    {freezeRegions.length > 0 && (
                        <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100">
                            <h3 className="font-semibold text-gray-800 mb-4">Freeze Logic Analysis</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Injected (Ground Truth) */}
                                {freezeRegions.filter(r => r.type === 'injected').map((r, i) => (
                                    <div key={i} className="bg-red-50 p-4 rounded-lg border border-red-100">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className="w-2 h-2 rounded-full bg-red-500"></span>
                                            <span className="font-semibold text-red-700 text-sm">Injection (Ground Truth)</span>
                                        </div>
                                        <div className="space-y-1 text-sm text-gray-600">
                                            <div className="flex justify-between"><span>Trigger Time:</span> <span className="font-mono">{formatTime(r.start)}</span></div>
                                            <div className="flex justify-between"><span>Duration:</span> <span className="font-mono">{r.duration.toFixed(2)}s</span></div>
                                        </div>
                                    </div>
                                ))}

                                {/* Detected (Monitor) */}
                                {freezeRegions.filter(r => r.type === 'detected').map((r, i) => (
                                    <div key={i} className="bg-yellow-50 p-4 rounded-lg border border-yellow-100">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className="w-2 h-2 rounded-full bg-yellow-500"></span>
                                            <span className="font-semibold text-yellow-700 text-sm">Detection (Monitor)</span>
                                        </div>
                                        <div className="space-y-1 text-sm text-gray-600">
                                            <div className="flex justify-between"><span>Detected At:</span> <span className="font-mono">{formatTime(r.start)}</span></div>
                                            <div className="flex justify-between"><span>Duration So Far:</span> <span className="font-mono">{r.duration.toFixed(2)}s</span></div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Right Column: Transcript */}
            <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-100 h-[600px] flex flex-col">
                <div className="flex items-center gap-2 mb-4 pb-4 border-b border-gray-100">
                    <MessageSquare size={20} className="text-indigo-600" />
                    <h3 className="font-semibold text-gray-800">Transcript</h3>
                </div>

                <div className="flex-1 overflow-y-auto space-y-4 pr-2">
                    {transcripts.map((msg, i) => {
                        const isActive = currentTime >= msg.timestamp && (transcripts[i + 1] ? currentTime < transcripts[i + 1].timestamp : true);
                        return (
                            <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                                <div className={`max-w-[85%] p-3 rounded-lg text-sm ${isActive ? 'ring-2 ring-indigo-400 ring-offset-1' : ''
                                    } ${msg.role === 'user'
                                        ? 'bg-indigo-600 text-white rounded-tr-none'
                                        : 'bg-gray-100 text-gray-800 rounded-tl-none'
                                    }`}>
                                    {msg.text}
                                </div>
                                <span className="text-xs text-gray-400 mt-1">{formatTime(msg.timestamp)}</span>
                            </div>
                        );
                    })}
                    {transcripts.length === 0 && <p className="text-center text-gray-400 italic mt-10">No transcript available.</p>}
                </div>
            </div>
        </div>
    );
}