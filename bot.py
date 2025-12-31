#
# Copyright (c) 2024–2025, Daily
#
# SPDX-License-Identifier: BSD 2-Clause License
#

"""Pipecat Quickstart Example.

The example runs a simple voice AI bot that you can connect to using your
browser and speak with it. You can also deploy this bot to Pipecat Cloud.

Required AI services:
- Deepgram (Speech-to-Text)
- OpenAI (LLM)
- Cartesia (Text-to-Speech)

Run the bot using::

    uv run bot.py
"""

import os
import json
import time
import asyncio

from dotenv import load_dotenv
from loguru import logger

print("🚀 Starting Pipecat bot...")
print("⏳ Loading models and imports (20 seconds, first run only)\n")

logger.info("Loading Local Smart Turn Analyzer V3...")
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3

logger.info("✅ Local Smart Turn Analyzer V3 loaded")
logger.info("Loading Silero VAD model...")
from pipecat.audio.vad.silero import SileroVADAnalyzer

logger.info("✅ Silero VAD model loaded")

from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import LLMRunFrame
from datetime import datetime, timezone

logger.info("Loading pipeline components...")
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.frameworks.rtvi import RTVIConfig, RTVIObserver, RTVIProcessor
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.daily.transport import DailyParams
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.processors.transcript_processor import TranscriptProcessor
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.frames.frames import UserStoppedSpeakingFrame, BotStartedSpeakingFrame
from pipecat.frames.frames import Frame, LLMFullResponseEndFrame, BotStoppedSpeakingFrame, TTSTextFrame, TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection


logger.info("✅ All components loaded successfully!")

load_dotenv(override=True)


class FreezeSimulator(FrameProcessor):
    """Strictly blocks TTS audio output on bot's n-th turn for k seconds."""
    
    def __init__(self, freeze_on_turn: int, freeze_duration_secs: float):
        super().__init__()
        self._freeze_on_turn = freeze_on_turn
        self._freeze_duration_secs = freeze_duration_secs
        self._turn_count = 0
        self._is_frozen = False
        self._freeze_start_time = None
        self._freeze_timestamp = None
        self._freeze_log = []
    
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        
        # Count completed bot turns
        if isinstance(frame, BotStoppedSpeakingFrame):
            self._turn_count += 1
            logger.info(f"🔄 Bot turn {self._turn_count} completed")
            
            if self._turn_count == self._freeze_on_turn - 1:
                self._is_frozen = True
                self._freeze_start_time = asyncio.get_event_loop().time()
                self._freeze_timestamp = None
                logger.warning(f"🥶 FREEZE ARMED: Will drop audio for {self._freeze_duration_secs}s")
        
        # DROP audio frames entirely during freeze (don't push them)
        if self._is_frozen and isinstance(frame, (TTSAudioRawFrame, TTSTextFrame)):
            if self._freeze_timestamp is None:
                 self._freeze_timestamp = datetime.now(timezone.utc).isoformat()

            elapsed = asyncio.get_event_loop().time() - self._freeze_start_time
            
            if elapsed < self._freeze_duration_secs:
                logger.debug(f"🚫 DROPPING frame: {type(frame).__name__}")
                return  # Don't push - frame is dropped
            else:
                self._is_frozen = False
                logger.warning(f"🔥 FREEZE ENDED: Resuming normal operation")
                
                # Log freeze details
                self._freeze_log.append({
                    "freeze_injected_at": self._freeze_timestamp,
                    "freeze_duration_secs": self._freeze_duration_secs,
                    "freeze_on_turn": self._freeze_on_turn
                })
                self._save_freeze_log()
        
        await self.push_frame(frame, direction)
    
    def _save_freeze_log(self):
        with open("freeze.json", "w") as f:
            json.dump(self._freeze_log, f, indent=4)
        logger.info(f"📝 Freeze log saved to freeze.json")

class LatencyJsonObserver(BaseObserver):
    def __init__(self):
        super().__init__()
        self.latencies = []
        self.user_stopped_time = None

    async def on_push_frame(self, data: FramePushed):
        if isinstance(data.frame, UserStoppedSpeakingFrame):
            self.user_stopped_time = time.time()
        elif isinstance(data.frame, BotStartedSpeakingFrame) and self.user_stopped_time:
            latency = time.time() - self.user_stopped_time
            self.latencies.append({"turn": len(self.latencies) + 1, "latency_secs": latency})
            self.user_stopped_time = None

    def save_to_json(self, filepath):
        with open(filepath, "w") as f:
            json.dump(self.latencies, f)

audiobuffer = AudioBufferProcessor()
transcript = TranscriptProcessor()
latency_observer = LatencyJsonObserver()
import random

freeze_simulator = FreezeSimulator(freeze_on_turn=3, freeze_duration_secs=random.randint(10, 30))


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
    logger.info(f"Starting bot")

    stt = DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY"))

    tts = CartesiaTTSService(
        api_key=os.getenv("CARTESIA_API_KEY"),
        voice_id="71a7ad14-091c-4e8e-a314-022ece01c121",  # British Reading Lady
    )

    llm = OpenAILLMService(api_key=os.getenv("OPENAI_API_KEY"))

    messages = [
        {
            "role": "system",
            "content": "You are a friendly AI assistant. Respond naturally and keep your answers conversational.",
        },
    ]

    context = LLMContext(messages)
    context_aggregator = LLMContextAggregatorPair(context)

    rtvi = RTVIProcessor(config=RTVIConfig(config=[]))

    pipeline = Pipeline(
        [
            transport.input(),  # Transport user input
            rtvi,  # RTVI processor
            stt,
            transcript.user(),      # Captures user speech
            context_aggregator.user(),  # User responses
            llm,  # LLM
            tts,  # TTS
            freeze_simulator,
            transport.output(),  # Transport bot output
            transcript.assistant(), # Captures bot speech
            audiobuffer,
            context_aggregator.assistant(),  # Assistant spoken responses
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
            observers=[latency_observer],
        ),
        observers=[RTVIObserver(rtvi)],
    )

    # Start recording and handle audio data
    await audiobuffer.start_recording()

    @audiobuffer.event_handler("on_audio_data")
    async def on_audio_data(buffer, audio, sample_rate, num_channels):
        import wave
        os.makedirs("recordings", exist_ok=True)
        with wave.open("recordings/recording.wav", "wb") as wf:
            wf.setnchannels(num_channels)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(audio)

    
    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info(f"Client connected")
        # Kick off the conversation.
        messages.append({"role": "system", "content": "Say hello and briefly introduce yourself."})
        await task.queue_frames([LLMRunFrame()])

    @transcript.event_handler("on_transcript_update")
    async def on_transcript_update(processor, frame):
        # Read existing transcript if it exists
        try:
            with open("transcript.json", "r") as f:
                history = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            history = []
        
        # Add new messages
        for m in frame.messages:
            entry = {"timestamp": m.timestamp, "role": m.role, "content": m.content}
            # Avoid duplicates by checking if already exists
            if entry not in history:
                history.append(entry)
                print(f"[{m.timestamp}] {m.role}: {m.content}")
        
        # Write updated transcript
        with open("transcript.json", "w") as f:
            json.dump(history, f, indent=4)


    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info(f"Client disconnected")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=runner_args.handle_sigint)

    # Save metadata
    with open("metadata.json", "w") as f:
        json.dump({"recording_start_time": datetime.now(timezone.utc).isoformat()}, f, indent=4)

    await runner.run(task)

    latency_observer.save_to_json("latency_data.json")


async def bot(runner_args: RunnerArguments):
    """Main bot entry point for the bot starter."""

    transport_params = {
        "daily": lambda: DailyParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.2)),
            turn_analyzer=LocalSmartTurnAnalyzerV3(),
        ),
        "webrtc": lambda: TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.2)),
            turn_analyzer=LocalSmartTurnAnalyzerV3(),
        ),
    }

    transport = await create_transport(runner_args, transport_params)

    await run_bot(transport, runner_args)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
