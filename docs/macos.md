# macOS support

Capri keeps the same Electron renderer and hook protocol on both desktop platforms. macOS-specific integrations use a small Swift/AppKit helper; the existing Windows PowerShell helper, Start menu/media-key paths, and NSIS installer remain in place.

## Requirements and running from source

- macOS 13 or newer, Apple Silicon or Intel.
- Node.js 20 or newer for source development.
- Apple's Command Line Tools: run `xcode-select --install` once if needed.

```sh
npm ci
npm start
```

`npm start` and `npm run dev` compile the helper for the current architecture before starting Electron. The helper build is a no-op on Windows/Linux. No Homebrew or Swift runtime installation is needed for the packaged app.

The menu is in the macOS menu bar and on Capri's right-click menu. **Command+Option+C** stows/restores her. **Command+Q** quits her. Chat and setup fields use native Edit shortcuts including paste and select all. Login startup is offered in the packaged app only; move it to its intended location before enabling it.

## Install a built app

`npm run dist:mac` writes a universal DMG and ZIP in `dist/`. CI uploads the same pair as the `Capri-macOS-test` artifact. The build is ad-hoc signed and not notarized.

1. Open the DMG and drag Capri to Applications.
2. The first launch is blocked by Gatekeeper. Control-click `Capri.app`, choose **Open**, then **Open** again. Or, in Terminal: `xattr -cr /Applications/Capri.app`.
3. Leave the app in Applications before turning on launch at login.

An ad-hoc signature lets the app run on another Mac after that quarantine removal. It is not a Developer ID signature. Hardened runtime is off, because the default hardened runtime rejects Electron's frameworks when the signature is ad-hoc. Do not put signing certificates in this repository.

## Native integrations and permissions

- **Window tracking:** Quartz lists window IDs and bounds in logical points, in front-to-back order. That path does not request Screen Recording. Maximized and fullscreen windows are not perches. Changes of Space, minimized or closed windows, and windows moved between displays are reflected by polling.
- **Other AIs:** if Accessibility is already granted, the helper also reads the front window's title and the main process matches it against the same fixed list Windows uses. The title is not sent to the window overlay. Closing that browser tab sends Command-W only while the page is still in front and Shift, Option, and Control are up. Command-Shift-W would close the whole window, so a held modifier is refused the same way the Windows helper refuses Ctrl-Shift-W. Capri does not prompt for Accessibility at launch. Grant it from the menu (the media-controls item opens the same pane) or tab close stays unavailable. Game detection and USB reactions stay Windows-only, because macOS has no equivalent that avoids a broader device scan.
- **App launching:** discovers `.app` bundles in `/Applications`, `/System/Applications`, and `~/Applications`, plus installed Steam manifests. A launch request must match an item in that inventory. Paths are passed as individual arguments, never shell commands. Epic manifests and Start menu shortcuts remain Windows-only.
- **Files and folders:** opens Finder, Trash, and the usual user folders. File search walks the same bounded folders by name and type. Windows Search stays Windows-only. Desktop app bundles, scripts, and installers still need the confirmation button.
- **Chat controls for the computer:** settings panes open System Settings URLs. Volume uses `osascript`. Sleep uses `pmset sleepnow`. Lock is Control-Command-Q through System Events, so it follows that shortcut. A screenshot snip runs `screencapture -i -c` and needs Screen Recording. Dark mode, hiding other apps, and placing a window on the left or right half use System Events and need Accessibility plus Automation for System Events. Shut down and restart are scheduled in a Capri process and confirmed by macOS. They do not use a root countdown. Cancel kills that process.
- **Screen pictures:** screenshot and optional screen commentary use Electron screen capture and may require Screen Recording. That is separate from window tracking. Leave commentary off for model-free checks. The app's Info.plist carries usage strings for AppleEvents, screen capture, and the audio-capture description macOS requires before screen capture works.
- **App closing:** lists regular running applications by bundle ID. A confirmed close asks the app to terminate normally so it can ask to save work. Force quit remains a second explicit confirmation. Finder, system components, Capri, Electron, the coding assistants, and Ollama are excluded.
- **Media keys:** macOS requires Accessibility for synthetic media key events. This is requested only after a media action. If denied, chat explains the requirement. The menu links to the Accessibility pane. Play and pause share one key, as on Windows.
- **Ollama:** detects the app in system/user Applications and common CLI locations, and opens the macOS app on request. Installing it is a manual download from [Ollama](https://ollama.com/download). Starting Claude Code/Codex through Ollama opens Terminal and may ask for macOS Automation permission. Denial is reported in the setup panel.
- **API keys:** Electron `safeStorage` uses the macOS Keychain. If it is unavailable, new keys are rejected rather than saved in plaintext. Chat history and other preferences are stored locally as ordinary JSON; keys are not returned to the renderer. Sending chat to a remote provider sends its conversation/context to that provider, as on Windows.

The overlay stays out of the menu bar. Screen-edge resting extends to the bottom of the display, with a bottom Dock acting as the ledge. A side Dock remains outside the overlay. Dock auto-hide, Spaces/fullscreen transitions, scaling, and display changes require manual validation on each target setup.

## Packaging

```sh
npm run dist:mac
```

This builds a universal helper and a universal DMG and ZIP in `dist/`. The helper ships in `Capri.app/Contents/Resources/capri-macos`, outside ASAR, so installed users do not need a compiler. The icon is an `.icns` scaled on the build Mac from `assets/icons/capri.png` (256 pixels, so it looks soft). `npm run dist` and `npm run dist:win` build the Windows NSIS installer. `npm run dist:linux` builds an AppImage and a deb.

CI runs the tests on macOS, Windows, and Linux, and uploads the DMG, ZIP, and Windows installer. It does not publish a release.

## Performance bounds

The window helper polls every 150 ms, emits only changed snapshots, and includes at most 40 windows. Each snapshot reads display geometry once and serializes JSON once. Concurrent installed-app requests share one scan, with successful inventories cached for ten minutes; failed scans can be retried.

The fallback file search streams directory entries asynchronously and yields to the main event loop every 256 entries. It processes at most 40,000 entries, collects at most 24 candidate matches, descends at most five levels, and returns up to eight results. Hidden and dependency folders are skipped. Windows still tries its search index first; these limits apply when falling back to folder traversal.

## Validation and review

`npm test` runs hook integration and platform-boundary regressions on macOS, Windows, and Linux in CI. These check the existing Windows routing, macOS point coordinates and negative display origins, Dock/taskbar geometry, translation isolation, launch allowlists, and Terminal error handling. CI packaging is a build check, not proof that the desktop interactions work.

Manual acceptance checklist for an isolated macOS VM (8 GB RAM or less):

- Launch from source, then the packaged app; confirm transparent background and no unexpected permission prompts.
- Click through empty areas, click/right-click Capri, drag her, open and dismiss panels, type/paste/select all, and press Escape. Stroke her mane back and forth until she purrs.
- Ask her to look at the screen. The first time, macOS asks for Screen Recording. Allow it, quit, reopen, and ask again.
- Test tray actions, stow/restore shortcut, quit/relaunch, saved preferences, and login startup in the installed app.
- Open a disposable window; perch, move, minimize, restore, and close it. Exercise the demo window.
- Test normal app launch, confirmed quit with an unsaved document, and cancellation. Use only disposable apps for force quit.
- Deny then allow media/Terminal permissions; verify visible failure and successful retry.
- Test first-run Ollama absence, installed-but-stopped state, and model setup separately. Do not use real API keys for UI tests.
- Test Dock positions/auto-hide, reduced motion, sleep/wake, Spaces/fullscreen, and multiple display/scaling layouts where available.

Windows acceptance still needs a Windows VM/PC: click-through after sleep/unlock, taskbar rest/foreground raising, PowerShell window tracking, Start menu/Steam/Epic launching, media keys, winget Ollama setup, NSIS install/startup, and hook install/uninstall. Do not infer these passes from macOS or mocked tests.

Current status (October 28, 2026): the branch incorporates upstream v0.4.4 (`3e6f529`) and its Windows behavior. All 40 automated tests passed locally, including scan budgets, event-loop responsiveness, directory cleanup, concurrent discovery/retry, panel reactivation, OpenAI model filtering, and billing/rate-limit error classification. Current hosted results and downloadable packages are on the [branch's Actions page](https://github.com/boBananaa/capri-desktop-macos/actions?query=branch%3Amacos-support). Earlier [hosted validation of `5c88ea8`](https://github.com/boBananaa/capri-desktop-macos/actions/runs/40588367181) passed all three OS test jobs and both package builds. Packaged build `b959798` was exercised in an isolated macOS 26.5.1 guest with 8 GiB RAM: transparent launch, a guest-local Custom provider, complete streamed Unicode text, typing immediately after opening chat from the menu bar, and TextEdit launch worked. Provider settings survived package replacement and relaunch.

A manual report on October 28 confirmed that Play demo appeared to work, but intermittent chat-input focus loss was also reported. Direct clicks on visible Mac chat/setup panels now request native app/window and web-content focus again; this correction has automated coverage and still needs a hands-on retest. Later focus-return and existing-chat refocus corrections have not been exercised in the guest. Automated overlay mouse input was unreliable; physical click-through/dragging, cancellation, native editing shortcuts, window tracking, permissions, startup, and the extended desktop checklist remain unverified. Windows interactive acceptance and signed/notarized distribution are also pending. Source review and successful packaging do not establish those passes.

### Chat UI tests without a model

Inside the disposable VM, start the deterministic fixture:

```sh
CAPRI_QA_GUEST=1 node tests/fixtures/mock-chat.cjs
```

If Node is absent, the installed app's bundled runtime can run the fixture:

```sh
CAPRI_QA_GUEST=1 ELECTRON_RUN_AS_NODE=1 /Applications/Capri.app/Contents/MacOS/Capri tests/fixtures/mock-chat.cjs
```

In Capri, select **Custom** and enter `http://127.0.0.1:47831/v1`. The model badge must say
`capri-qa-mock` before sending a test message. The fixture returns fixed streamed Unicode text;
`long` returns a longer stream for cancellation testing. Only explicit `open TextEdit` and
`close TextEdit` inputs produce those fixed action tags. Use a disposable document.

This fixture binds only to guest localhost and makes no outbound requests. Do not point UI tests
at the host's Ollama service: opening an Ollama chat can preload its selected model before a
message is sent. Keep a separate, empty guest account and avoid real keys and personal files.

### OpenAI chat setup

The OpenAI option uses an API key. The general model catalog includes speech, image, embedding, and specialized endpoint models; these are excluded from Capri's text-chat list. Billing/quota failures (including HTTP 429 credit or spend-limit errors) surface the provider's explanation immediately instead of retrying other models or claiming the servers are busy. A successful model-list lookup does not establish that the account can fund a chat request.
