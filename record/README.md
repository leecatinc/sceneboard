# SceneBoard lightweight Windows recorder

This folder records a fixed `1920×1080` desktop region containing the SceneBoard browser and an overlaid Codex command window. It uses only Python's standard library and `ffmpeg`.

## Requirements

- Windows 10 or 11
- Python 3 with the Windows `py` launcher
- `ffmpeg.exe` available on `PATH`
- A `1920×1080` or larger display

## Prepare the demo

1. Open Chrome at the top-left of the primary display and size it to cover the recording area.
2. Open the CMD window that will run Codex.
3. In that Codex CMD window, run:

   ```cmd
   title SceneBoard Codex
   ```

4. Keep SceneBoard in English and close notifications, password managers, and unrelated tabs.
5. The default white privacy mask covers the account-email area at `1680,112` with size `240×58`. Adjust or remove the `--mask` line in `record.cmd` only after confirming no private account information is visible.

## Record

1. Double-click `record.cmd` from File Explorer.
2. The script moves the window titled `SceneBoard Codex` to `1340,210` with size `580×870`.
3. Arrange the browser if needed and press Enter in the recorder window.
4. After the three-second countdown, the recorder window minimizes and recording begins.
5. Press **F10** globally to stop.
6. The final MP4 is written under `record/output/`.

The capture stops automatically after ten minutes if F10 is not pressed.

## Optional microphone audio

Find the exact Windows DirectShow device name with:

```cmd
ffmpeg -list_devices true -f dshow -i dummy
```

Then add this argument to `record.cmd`:

```cmd
--audio-device "Microphone device name shown by ffmpeg"
```

For the cleanest hackathon submission, recording narration separately and mixing it during final editing is usually easier.

## Adjustments

- Change `--fps 60` to `--fps 30` for a smaller file.
- Change `--terminal-x`, `--terminal-y`, `--terminal-width`, and `--terminal-height` to reposition Codex.
- Add another `--mask X,Y,W,H` to cover another private area.
- Change `--max-seconds 600` to set a different safety limit.

Recording is first written as MKV so an interruption is less likely to destroy the entire take. It is remuxed to MP4 automatically after a clean stop.
