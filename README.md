# Downloader

A small Windows app that saves a link as **MP4** video or **MP3** / **WAV** audio. Paste a link, pick a format, click Download. Videos and audio go to separate folders that you choose.

It uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) for page links and [ffmpeg](https://ffmpeg.org/) for converting and merging. Direct links to media files (`.mp4`, `.mp3`, `.wav`, …) work too.

![Downloader in light and dark mode](docs/screenshot.png)

## Features

- MP4, MP3, or WAV from any page yt-dlp supports, or from a direct media link
- separate save folders for video (MP4) and audio (MP3/WAV)
- pastes a copied link automatically when the window opens
- waits in the system tray and can start with Windows
- optional console commands: type `mp3` or `video` in a terminal to open it with that format selected
- keeps yt-dlp up to date by itself (checked at most once a week)
- light and dark mode, following Windows
- also runs as a local web app on any OS with Node.js

![Ready, finished, and error states](docs/states.png)

## Install on Windows

1. Install ffmpeg. The easiest way is:

   ```powershell
   winget install Gyan.FFmpeg
   ```

2. Download `Downloader-<version>-win-x64.zip` from the [latest release](https://github.com/MartinGeltl21/media-downloader/releases/latest).
3. Unzip it and move the `Downloader` folder somewhere it can stay, for example to `%LOCALAPPDATA%\Programs\Downloader`. The console commands point to this folder, so turn them off before moving it later.
4. Run `Downloader.exe`. To keep it handy, right-click its taskbar icon and choose **Pin to taskbar**.

The app is not code-signed, so Windows SmartScreen may warn on first start. Choose **More info** and then **Run anyway**.

## Using it

1. Copy a link, for example a YouTube video URL.
2. Open Downloader. The copied link is already in the field.
3. Pick **MP4**, **MP3**, or **WAV** and click **Download**.
4. When it finishes, **Show in folder** opens the file in Explorer.

The two folder icons at the bottom right, **MP4** and **MP3**, choose where videos and audio are saved. Hover over one to see the current folder. By default, videos go to `Videos\Downloader` and audio to `Music\Downloader`.

Closing the window only hides it. Downloader keeps running in the system tray, so it opens instantly next time. Use **Quit** in the tray menu to stop it.

### Start with Windows

Right-click the tray icon and enable **Start with Windows**. Downloader then starts hidden in the tray when you sign in.

### Console commands

Right-click the tray icon and enable **Console commands (mp3, video)**. This adds the app's command folder to your user `PATH`. Then, in any **new** PowerShell, Command Prompt, or Windows Terminal window:

| Command | Opens Downloader with |
| --- | --- |
| `mp3` | MP3 selected |
| `video` | MP4 selected |

Copy a link, type `mp3`, press Enter, and click Download. Turning the option off removes the folder from `PATH` again. Git Bash does not run `.cmd` files by name, so use PowerShell or Command Prompt there.

## Build from source

Requirements: Windows, Node.js 20 or newer, ffmpeg on `PATH`.

```powershell
git clone https://github.com/MartinGeltl21/media-downloader.git
cd media-downloader
npm install
```

| Command | What it does |
| --- | --- |
| `npm run app` | runs the desktop app from source |
| `npm run install-app` | builds the app, installs it to `%LOCALAPPDATA%\Programs\Downloader`, adds Start menu and desktop shortcuts, and turns on autostart and the console commands |
| `npm run release` | builds `dist\Downloader-<version>-win-x64.zip` |
| `npm start` | runs the web version at `http://localhost:3210` |
| `npm run check` | syntax check for all scripts |

`install-app` accepts `-NoAutostart` and `-NoCommands` if you want to skip those:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1 -NoAutostart -NoCommands
```

Pushing a tag like `v1.0.1` builds the Windows zip on GitHub Actions and attaches it to the release.

## Web version

`npm start` serves the same interface in the browser at `http://localhost:3210` and saves files to the `downloads/` folder in the project. This works on Windows, macOS, and Linux, as long as Node.js and ffmpeg are installed. The folder icons and console commands are only part of the desktop app.

The web version needs a real server process: it runs yt-dlp and ffmpeg and writes files to disk. Static hosting (GitHub Pages, Netlify) and most serverless platforms cannot run it. A VPS or your own machine can.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3210` | port of the web server |
| `HOST` | all interfaces | address to listen on, for example `127.0.0.1` |
| `FFMPEG_PATH` | found on `PATH` | full path to `ffmpeg` |
| `YT_DLP_COOKIES_FILE` | `cookies.txt` | cookie file for signed-in sources |
| `YT_DLP_COOKIES_FROM_BROWSER` | none | read cookies from `chrome`, `edge`, `brave`, or `firefox` |

## Signed-in sources and cookies

Some posts (for example age-restricted or private Reddit and YouTube content) are only available to signed-in accounts. Downloader then needs your browser cookies in a Netscape-format `cookies.txt`:

- desktop app: `%APPDATA%\Downloader\cookies.txt`
- web version: `cookies.txt` in the project folder

The file is picked up automatically, also when you add it while the app is running. One way to create it for the desktop app is to close the browser completely and run the bundled yt-dlp once:

```powershell
& "$env:APPDATA\Downloader\bin\yt-dlp.exe" --cookies-from-browser chrome --cookies "$env:APPDATA\Downloader\cookies.txt" --skip-download "LINK_TO_A_POST"
```

For the web version, run `.\bin\yt-dlp.exe` from the project folder with `--cookies cookies.txt` instead.

`cookies.txt` contains your login sessions. Never share or commit it.

## Where things are stored

| What | Where |
| --- | --- |
| finished videos | `Videos\Downloader` (changeable) |
| finished audio | `Music\Downloader` (changeable) |
| settings, yt-dlp, cookies, temporary files | `%APPDATA%\Downloader` |
| installed app (when built with `install-app`) | `%LOCALAPPDATA%\Programs\Downloader` |

## Troubleshooting

**"ffmpeg is missing"**: install ffmpeg (`winget install Gyan.FFmpeg`), then quit Downloader from the tray and start it again so it sees the new `PATH`.

**YouTube says it is blocking the request or asks to confirm you are not a bot**: add cookies as described above. yt-dlp updates itself weekly; if a site just changed, wait for the next yt-dlp release or delete `%APPDATA%\Downloader\bin\yt-dlp.exe` to fetch the latest one on next start.

**"Please paste a direct YouTube video link"**: search, channel, and profile pages are not supported. Open the video and copy its address.

**`mp3` is not recognized**: enable the console commands in the tray menu and open a new terminal window.

**Some MP4 files do not play in an editor**: YouTube often delivers AV1 video. Most players handle it; some editors need an AV1 codec or a conversion first.

## How it works

The desktop app is an [Electron](https://www.electronjs.org/) shell (`desktop/`) around the web app. It starts `server.js` in the background under Electron's bundled Node.js, opens the interface in its own window, and moves finished files into the folder for their format. `server.js` is an [Express](https://expressjs.com/) server that downloads yt-dlp on first use and runs it with Node.js as its JavaScript runtime. The interface in `public/` is plain HTML, CSS, and JavaScript.

## Responsible use

Only download content you have the right to download, and respect the terms of the sites you use and the rights of creators. This project is not affiliated with YouTube, Reddit, or any other site.

## Credits and license

The original web app was written by [Leonxlnx](https://github.com/Leonxlnx). The Windows desktop app, tray, console commands, and redesign were added by [MartinGeltl21](https://github.com/MartinGeltl21).

Released under the [MIT License](LICENSE). yt-dlp and ffmpeg are separate projects with their own licenses; Downloader downloads yt-dlp at runtime and expects ffmpeg to be installed separately.
