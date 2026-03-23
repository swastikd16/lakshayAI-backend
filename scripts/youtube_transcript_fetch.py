#!/usr/bin/env python3
import argparse
import json
import signal
import sys
from typing import Any, Dict, List

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
)


class TimeoutError(Exception):
    pass


def timeout_handler(signum, frame):
    raise TimeoutError("Transcript fetch timed out.")


def emit(payload: Dict[str, Any], exit_code: int = 0):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(exit_code)


def normalize_segment(item: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "text": str(item.get("text", "")).strip(),
        "start": float(item.get("start", 0) or 0),
        "duration": float(item.get("duration", 0) or 0),
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch YouTube transcript using youtube-transcript-api.")
    parser.add_argument("--video-id", required=True)
    parser.add_argument("--languages", default="en,en-IN,hi")
    parser.add_argument("--timeout-ms", type=int, default=15000)
    args = parser.parse_args()

    timeout_seconds = max(5, int(args.timeout_ms / 1000))
    signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(timeout_seconds)

    video_id = str(args.video_id).strip()
    languages = [lang.strip() for lang in str(args.languages).split(",") if lang.strip()]
    if not languages:
        languages = ["en", "en-IN", "hi"]

    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
        selected = transcript_list.find_transcript(languages)
        source = "generated" if selected.is_generated else "manual"
        fetched = selected.fetch()
        language = selected.language_code
    except NoTranscriptFound:
        try:
            transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
            selected = transcript_list.find_generated_transcript(languages)
            source = "generated"
            fetched = selected.fetch()
            language = selected.language_code
        except NoTranscriptFound:
            emit(
                {
                    "ok": False,
                    "errorCode": "LANGUAGE_NOT_AVAILABLE",
                    "message": "No transcript available for requested languages."
                },
                1,
            )
    except TranscriptsDisabled:
        emit(
            {
                "ok": False,
                "errorCode": "TRANSCRIPT_UNAVAILABLE",
                "message": "Transcripts are disabled for this video."
            },
            1,
        )
    except VideoUnavailable:
        emit(
            {
                "ok": False,
                "errorCode": "VIDEO_NOT_FOUND",
                "message": "Video is unavailable."
            },
            1,
        )
    except TimeoutError:
        emit(
            {
                "ok": False,
                "errorCode": "FETCH_TIMEOUT",
                "message": "Transcript fetch timed out."
            },
            1,
        )
    except Exception as exc:
        emit(
            {
                "ok": False,
                "errorCode": "TRANSCRIPT_UNAVAILABLE",
                "message": str(exc) or "Unable to fetch transcript."
            },
            1,
        )

    segments: List[Dict[str, Any]] = [normalize_segment(item) for item in fetched]
    transcript_text = "\n".join([segment["text"] for segment in segments if segment["text"]]).strip()

    signal.alarm(0)
    emit(
        {
            "ok": True,
            "videoId": video_id,
            "language": language if "language" in locals() else None,
            "source": source if "source" in locals() else "unknown",
            "transcript": transcript_text,
            "segments": segments,
        }
    )


if __name__ == "__main__":
    main()
