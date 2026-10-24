# Changelog

## 1.1.0 (2026-10-25)

- macOS (Apple silicon and Intel) and Linux x64 builds
- open at login and the `mp3` / `video` console commands on macOS and Linux
- standalone yt-dlp builds on every system, so macOS and Linux need no Python
- ffmpeg is also found in the Homebrew and Snap folders when the app is started from the Finder or a desktop launcher
- the ffmpeg hint names the install command for the current system
- release builds are smoke-tested on GitHub Actions before they are published

## 1.0.0 (2026-10-25)

First public release.

- Windows desktop app with its own window, tray icon, and single instance
- MP4, MP3, and WAV downloads with separate, changeable folders for video and audio
- copied links are pasted automatically
- optional autostart and `mp3` / `video` console commands, both switchable from the tray menu
- weekly yt-dlp self-update and Electron's Node.js as yt-dlp's JavaScript runtime
- clear message when ffmpeg is missing
- light and dark theme
- web version with cookie support for signed-in sources
