import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

type TranscriptItem = {
    timestamp: string;
    role: 'user' | 'assistant';
    content: string;
};

type LatencyItem = {
    turn: number;
    latency_secs: number;
};

export async function GET() {
    try {
        // Paths relative to the project root (where next runs, usually frontend/)
        // Adjust dependent on where 'next dev' is run. Assuming 'frontend' dir.
        // So repo root is one level up.
        const transcriptPath = path.join(process.cwd(), '../transcript.json');
        const latencyPath = path.join(process.cwd(), '../latency_data.json');
        const metadataPath = path.join(process.cwd(), '../metadata.json');

        let sessionStartEvent: any = null;
        let transcriptEvents: any[] = [];
        let latencyEvents: any[] = [];

        // Try to get session start from metadata first for accurate sync
        if (fs.existsSync(metadataPath)) {
            const metadataRaw = fs.readFileSync(metadataPath, 'utf-8');
            const metadata = JSON.parse(metadataRaw);
            if (metadata.recording_start_time) {
                sessionStartEvent = {
                    event: 'session_start',
                    timestamp: metadata.recording_start_time
                };
            }
        }

        if (fs.existsSync(transcriptPath)) {
            const transcriptRaw = fs.readFileSync(transcriptPath, 'utf-8');
            const fullTranscript: TranscriptItem[] = JSON.parse(transcriptRaw);

            // Sort by timestamp just in case
            fullTranscript.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

            if (fullTranscript.length > 0) {
                // Group into sessions based on time gap (> 2 minutes)
                const sessions: TranscriptItem[][] = [];
                let currentSession: TranscriptItem[] = [fullTranscript[0]];

                for (let i = 1; i < fullTranscript.length; i++) {
                    const prevTime = new Date(fullTranscript[i - 1].timestamp).getTime();
                    const currTime = new Date(fullTranscript[i].timestamp).getTime();

                    if (currTime - prevTime > 2 * 60 * 1000) { // 2 minutes gap
                        sessions.push(currentSession);
                        currentSession = [];
                    }
                    currentSession.push(fullTranscript[i]);
                }
                sessions.push(currentSession);

                // Take the latest session
                const latestSession = sessions[sessions.length - 1];

                // Set session start to the time of the first message in the session IF not already set by metadata
                if (!sessionStartEvent) {
                    const startTimeStr = latestSession[0].timestamp;
                    sessionStartEvent = {
                        event: 'session_start',
                        timestamp: startTimeStr
                    };
                }

                transcriptEvents = latestSession.map(item => ({
                    event: 'transcript',
                    timestamp: item.timestamp,
                    role: item.role,
                    text: item.content
                }));
            }
        }

        if (fs.existsSync(latencyPath)) {
            const latencyRaw = fs.readFileSync(latencyPath, 'utf-8');
            const latencyData: LatencyItem[] = JSON.parse(latencyRaw);

            latencyEvents = latencyData.map(item => ({
                event: 'latency',
                turn: item.turn,
                latency_ms: item.latency_secs * 1000
            }));
        }

        // Process Freeze Data
        const freezePath = path.join(process.cwd(), '../freeze.json');
        let freezeEvents: any[] = [];
        if (fs.existsSync(freezePath)) {
            const freezeRaw = fs.readFileSync(freezePath, 'utf-8');
            const freezeData = JSON.parse(freezeRaw);

            freezeData.forEach((item: any) => {
                // Freeze Start Event
                freezeEvents.push({
                    event: 'freeze_injected',
                    timestamp: item.freeze_injected_at
                });

                // Freeze End Event
                const startTime = new Date(item.freeze_injected_at).getTime();
                const endTime = startTime + (item.freeze_duration_secs * 1000);
                freezeEvents.push({
                    event: 'freeze_end',
                    timestamp: new Date(endTime).toISOString()
                });
            });
        }

        // Heuristic: Detect freezes based on Transcript Gaps
        let detectedFreezeEvents: any[] = [];
        let assistantTurnCount = 0;

        if (transcriptEvents.length > 1) {
            for (let i = 0; i < transcriptEvents.length - 1; i++) {
                const current = transcriptEvents[i];
                const next = transcriptEvents[i + 1];

                const isUserToAssistant = current.role === 'user' && next.role === 'assistant';
                const isUserToUser = current.role === 'user' && next.role === 'user';

                if (isUserToAssistant) {
                    assistantTurnCount++;
                    const latencyItem = latencyEvents.find(l => l.turn === assistantTurnCount);

                    if (latencyItem) {
                        const gapSec = latencyItem.latency_ms / 1000;
                        if (gapSec > 3.0) {
                            const botStart = new Date(next.timestamp).getTime();
                            const userEnd = botStart - (gapSec * 1000);

                            const detectionStart = userEnd + 3000;
                            const duration = gapSec - 3.0;

                            detectedFreezeEvents.push({
                                event: 'freeze_detected',
                                timestamp: new Date(detectionStart).toISOString(),
                                duration: duration
                            });
                        }
                    } else {
                        const wordCount = current.text ? current.text.split(' ').length : 1;
                        const estUserDuration = wordCount * 0.3;

                        const t1 = new Date(current.timestamp).getTime();
                        const t2 = new Date(next.timestamp).getTime();
                        const userEnd = t1 + (estUserDuration * 1000);
                        const gapSec = (t2 - userEnd) / 1000;

                        if (gapSec > 3.0) {
                            const detectionStart = userEnd + 3000;
                            const duration = gapSec - 3.0;
                            detectedFreezeEvents.push({
                                event: 'freeze_detected',
                                timestamp: new Date(detectionStart).toISOString(),
                                duration: duration
                            });
                        }
                    }
                } else if (isUserToUser) {
                    const wordCount = current.text ? current.text.split(' ').length : 1;
                    const estUserDuration = wordCount * 0.3;

                    const t1 = new Date(current.timestamp).getTime();
                    const t2 = new Date(next.timestamp).getTime();
                    const userEnd = t1 + (estUserDuration * 1000);
                    const gapSec = (t2 - userEnd) / 1000;

                    if (gapSec > 2.0) {
                        const detectionStart = userEnd + 2000;
                        const duration = gapSec - 2.0;
                        detectedFreezeEvents.push({
                            event: 'freeze_detected',
                            timestamp: new Date(detectionStart).toISOString(),
                            duration: duration
                        });
                    }
                }
            }
        }

        const events = [
            ...(sessionStartEvent ? [sessionStartEvent] : []),
            ...transcriptEvents,
            ...latencyEvents,
            ...freezeEvents,
            ...detectedFreezeEvents
        ];

        return NextResponse.json(events);

    } catch (error) {
        console.error("Error serving events:", error);
        return NextResponse.json({ error: 'Failed to process events' }, { status: 500 });
    }
}
