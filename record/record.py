#!/usr/bin/env python3
"""Lightweight Windows recorder for the SceneBoard demo."""

from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Iterable


VK_F10 = 0x79
SW_MINIMIZE = 6


def positive_even(value: str) -> int:
    parsed = int(value)
    if parsed <= 0 or parsed % 2 != 0:
        raise argparse.ArgumentTypeError("value must be a positive even integer")
    return parsed


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


def parse_mask(value: str) -> tuple[int, int, int, int]:
    try:
        parts = tuple(int(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("mask must be X,Y,WIDTH,HEIGHT") from error
    if len(parts) != 4 or min(parts) < 0 or parts[2] <= 0 or parts[3] <= 0:
        raise argparse.ArgumentTypeError("mask must be X,Y,WIDTH,HEIGHT with a positive size")
    return parts


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Record the SceneBoard browser and overlaid Codex terminal on Windows.")
    result.add_argument("--x", type=int, default=0, help="capture origin X")
    result.add_argument("--y", type=int, default=0, help="capture origin Y")
    result.add_argument("--width", type=positive_even, default=1920)
    result.add_argument("--height", type=positive_even, default=1080)
    result.add_argument("--fps", type=positive_int, default=60)
    result.add_argument("--countdown", type=positive_int, default=3)
    result.add_argument("--max-seconds", type=positive_int, default=600)
    result.add_argument("--terminal-title", default="SceneBoard Codex")
    result.add_argument("--terminal-x", type=int, default=1340)
    result.add_argument("--terminal-y", type=int, default=210)
    result.add_argument("--terminal-width", type=positive_int, default=580)
    result.add_argument("--terminal-height", type=positive_int, default=870)
    result.add_argument("--mask", action="append", type=parse_mask, default=[], metavar="X,Y,W,H")
    result.add_argument("--audio-device", default="", help="optional DirectShow audio device name")
    result.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent / "output")
    result.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg executable or absolute path")
    return result


def find_ffmpeg(value: str) -> str:
    explicit = Path(value)
    if explicit.is_file():
        return str(explicit.resolve())
    discovered = shutil.which(value)
    if discovered is None:
        raise RuntimeError("ffmpeg was not found. Install it and make ffmpeg.exe available on PATH.")
    return discovered


def configure_windows_dpi() -> None:
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except (AttributeError, OSError):
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except (AttributeError, OSError):
            pass


def find_window(title: str) -> int | None:
    user32 = ctypes.windll.user32
    matches: list[int] = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def visit(handle: int, _: int) -> bool:
        length = user32.GetWindowTextLengthW(handle)
        if length <= 0 or not user32.IsWindowVisible(handle):
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(handle, buffer, len(buffer))
        if title.casefold() in buffer.value.casefold():
            matches.append(int(handle))
        return True

    user32.EnumWindows(callback_type(visit), 0)
    return matches[0] if matches else None


def position_terminal(title: str, x: int, y: int, width: int, height: int) -> bool:
    handle = find_window(title)
    if handle is None:
        return False
    return bool(ctypes.windll.user32.MoveWindow(handle, x, y, width, height, True))


def minimize_recorder_console() -> None:
    handle = ctypes.windll.kernel32.GetConsoleWindow()
    if handle:
        ctypes.windll.user32.ShowWindow(handle, SW_MINIMIZE)


def masks_filter(masks: Iterable[tuple[int, int, int, int]]) -> str | None:
    filters = [f"drawbox=x={x}:y={y}:w={width}:h={height}:color=white@1:t=fill" for x, y, width, height in masks]
    return ",".join(filters) if filters else None


def recording_command(arguments: argparse.Namespace, ffmpeg: str, raw_path: Path) -> list[str]:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "warning",
        "-y",
        "-thread_queue_size", "1024",
        "-f", "gdigrab",
        "-framerate", str(arguments.fps),
        "-offset_x", str(arguments.x),
        "-offset_y", str(arguments.y),
        "-video_size", f"{arguments.width}x{arguments.height}",
        "-draw_mouse", "1",
        "-i", "desktop",
    ]
    if arguments.audio_device:
        command.extend(["-thread_queue_size", "1024", "-f", "dshow", "-i", f"audio={arguments.audio_device}", "-map", "0:v:0", "-map", "1:a:0"])
    else:
        command.append("-an")
    video_filter = masks_filter(arguments.mask)
    if video_filter is not None:
        command.extend(["-vf", video_filter])
    command.extend([
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
    ])
    if arguments.audio_device:
        command.extend(["-c:a", "aac", "-b:a", "192k"])
    command.append(str(raw_path))
    return command


def stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if process.stdin is not None:
        try:
            process.stdin.write(b"q\n")
            process.stdin.flush()
            process.wait(timeout=15)
            return
        except (BrokenPipeError, subprocess.TimeoutExpired):
            pass
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def remux(ffmpeg: str, raw_path: Path, final_path: Path) -> None:
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "warning", "-y",
        "-i", str(raw_path), "-c", "copy", "-movflags", "+faststart", str(final_path),
    ], check=True)


def main() -> int:
    if os.name != "nt":
        print("This recorder is intended for Windows.", file=sys.stderr)
        return 2
    arguments = parser().parse_args()
    configure_windows_dpi()
    try:
        ffmpeg = find_ffmpeg(arguments.ffmpeg)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 2

    arguments.output_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    raw_path = arguments.output_dir / f"sceneboard-demo-{stamp}.mkv"
    final_path = arguments.output_dir / f"sceneboard-demo-{stamp}.mp4"

    positioned = position_terminal(
        arguments.terminal_title,
        arguments.terminal_x,
        arguments.terminal_y,
        arguments.terminal_width,
        arguments.terminal_height,
    )
    if positioned:
        print(f"Positioned '{arguments.terminal_title}' at {arguments.terminal_x},{arguments.terminal_y} ({arguments.terminal_width}x{arguments.terminal_height}).")
    else:
        print(f"Warning: no visible window containing '{arguments.terminal_title}' was found.")
        print(f"Run this in the Codex terminal first: title {arguments.terminal_title}")

    print(f"Capture: {arguments.width}x{arguments.height} at {arguments.fps} fps from {arguments.x},{arguments.y}")
    print("Press Enter when the browser and Codex terminal are ready.")
    input()
    for remaining in range(arguments.countdown, 0, -1):
        print(f"Recording starts in {remaining}…", flush=True)
        try:
            import winsound
            winsound.Beep(760, 120)
        except RuntimeError:
            pass
        time.sleep(1)

    minimize_recorder_console()
    process = subprocess.Popen(recording_command(arguments, ffmpeg, raw_path), stdin=subprocess.PIPE)
    started = time.monotonic()
    try:
        while process.poll() is None:
            if ctypes.windll.user32.GetAsyncKeyState(VK_F10) & 0x8000:
                while ctypes.windll.user32.GetAsyncKeyState(VK_F10) & 0x8000:
                    time.sleep(0.05)
                break
            if time.monotonic() - started >= arguments.max_seconds:
                break
            time.sleep(0.08)
    except KeyboardInterrupt:
        pass
    finally:
        stop_process(process)

    if process.returncode not in (0, 255) or not raw_path.exists() or raw_path.stat().st_size == 0:
        print("Recording failed. Keep the console open and inspect the ffmpeg message.", file=sys.stderr)
        return 1
    try:
        remux(ffmpeg, raw_path, final_path)
    except subprocess.CalledProcessError:
        print(f"Recording was saved as MKV but MP4 conversion failed: {raw_path}", file=sys.stderr)
        return 1
    raw_path.unlink(missing_ok=True)
    print(f"Saved: {final_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
