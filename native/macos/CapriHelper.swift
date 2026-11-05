// Small macOS adapter. Window bounds come from Quartz and do not need Screen Recording.
// A front-window title is read through Accessibility only after that permission is already
// granted, and only so the main process can match a fixed list of other AIs. The watch
// loop never asks for the permission itself.
import AppKit
import ApplicationServices

func emitJSON(_ data: Data) {
    guard let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func emit(_ value: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    emitJSON(data)
}

let protectedNames: Set<String> = [
    "finder", "dock", "systemuiserver", "windowmanager", "loginwindow",
    "capri", "electron", "claude", "codex", "ollama", "ollama app"
]
func closable(_ app: NSRunningApplication) -> Bool {
    app.activationPolicy == .regular && !app.isTerminated
        && !protectedNames.contains((app.localizedName ?? "").lowercased())
        && app.bundleIdentifier != nil
}

func runningApps() -> [[String: Any]] {
    var grouped: [String: [NSRunningApplication]] = [:]
    for app in NSWorkspace.shared.runningApplications where closable(app) {
        grouped[app.bundleIdentifier!, default: []].append(app)
    }
    return grouped.keys.sorted().map { id in
        let apps = grouped[id]!
        let name = apps[0].localizedName ?? id
        return ["name": name, "label": name, "process": id, "ids": apps.map { $0.processIdentifier }]
    }
}

func installedApps() -> [[String: String]] {
    let fm = FileManager.default
    let roots = ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"]
    var result: [[String: String]] = []
    for root in roots {
        guard let files = fm.enumerator(at: URL(fileURLWithPath: root),
            includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
        for case let url as URL in files {
            // Applications and their category folders; never traverse arbitrary deep trees.
            if files.level > 3 { files.skipDescendants(); continue }
            guard url.pathExtension == "app", let bundle = Bundle(url: url) else { continue }
            let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
                ?? url.deletingPathExtension().lastPathComponent
            result.append(["name": name, "kind": "app", "id": url.path])
        }
    }
    return result
}

func windowGeometry(excluding windowID: Int) -> [String: Any] {
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    let frontPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
    // Display geometry is shared by every window in this snapshot.
    let displays = NSScreen.screens.map { screen -> (bounds: CGRect, workHeight: CGFloat) in
        let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID ?? 0
        return (CGDisplayBounds(id), screen.visibleFrame.height)
    }
    var foreground = 0
    var windows: [[String: Any]] = []
    for row in rows {
        guard let id = row[kCGWindowNumber as String] as? Int, id != windowID,
              let layer = row[kCGWindowLayer as String] as? Int, layer == 0,
              let alpha = row[kCGWindowAlpha as String] as? Double, alpha > 0,
              let bounds = row[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds), rect.width >= 200, rect.height >= 120 else { continue }
        let owner = row[kCGWindowOwnerPID as String]
        let pid: Int
        if let n = owner as? Int { pid = n }
        else if let n = owner as? Int32 { pid = Int(n) }
        else if let n = owner as? NSNumber { pid = n.intValue }
        else { pid = 0 }
        // Owner pid arrives as Int, Int32, or NSNumber. The same value has to decide which window is front.
        if foreground == 0, let front = frontPID, pid > 0, pid == Int(front) { foreground = id }
        // Quartz and Electron both use logical points with a top-left primary-display origin.
        let maximized = displays.contains { display in
            let full = display.bounds
            return abs(rect.minX - full.minX) < 2 && abs(rect.width - full.width) < 2
                && rect.height >= display.workHeight - 2
        }
        windows.append(["id": id, "pid": pid, "x": rect.minX, "y": rect.minY,
                        "w": rect.width, "h": rect.height, "max": maximized])
        if windows.count >= 40 { break }
    }
    return ["fg": foreground, "frontPid": frontPID ?? 0, "wins": windows]
}

func snapshot(excluding windowID: Int) -> [String: Any] {
    var result = windowGeometry(excluding: windowID)
    let front = frontInfo()
    result["trusted"] = front.trusted
    if front.trusted {
        result["title"] = front.title
        result["bundle"] = front.bundle
    }
    return result
}

func frontInfo() -> (title: String, bundle: String, trusted: Bool) {
    let trusted = AXIsProcessTrusted()
    guard trusted, let app = NSWorkspace.shared.frontmostApplication else { return ("", "", trusted) }
    let bundle = app.bundleIdentifier ?? ""
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var windowRef: AnyObject?
    guard AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
          let window = windowRef else { return ("", bundle, trusted) }
    var titleRef: AnyObject?
    AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &titleRef)
    return (titleRef as? String ?? "", bundle, trusted)
}

// Command-Shift-W closes the whole window, and Command-Option-W closes the other tabs.
// Read at the moment of the decision. A saved flag from earlier in the zap would refuse a close
// the keyboard is no longer holding, or miss one that is.
func modifiersHeld() -> Bool {
    let held = CGEventSource.flagsState(.hidSystemState)
    return held.contains(.maskShift) || held.contains(.maskAlternate) || held.contains(.maskControl)
}

func focus(pid: Int32) {
    if modifiersHeld() { emit(["ok": false, "why": "keys"]); return }
    guard pid > 0, let target = NSRunningApplication(processIdentifier: pid), !target.isTerminated else {
        emit(["ok": false, "why": "front"]); return
    }
    let activated = target.activate(options: [.activateIgnoringOtherApps])
    let deadline = Date().addingTimeInterval(0.45)
    while Date() < deadline && NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    if modifiersHeld() { emit(["ok": false, "why": "keys"]); return }
    emit(["ok": activated && front, "why": front ? "" : "front"])
}

func closeTab(pid: Int32) {
    if modifiersHeld() { emit(["ok": false, "why": "keys"]); return }
    guard AXIsProcessTrusted() else { emit(["ok": false, "why": "keys"]); return }
    guard pid > 0, let target = NSRunningApplication(processIdentifier: pid), !target.isTerminated else {
        emit(["ok": false, "why": "front"]); return
    }
    // The overlay can be key by the time the zap lands. Bring this browser back and do not
    // send the key until it is the front app.
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        target.activate(options: [.activateIgnoringOtherApps])
        let deadline = Date().addingTimeInterval(0.45)
        while Date() < deadline && NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        }
    }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        emit(["ok": false, "why": "front"]); return
    }
    if modifiersHeld() { emit(["ok": false, "why": "keys"]); return }
    guard let source = CGEventSource(stateID: .hidSystemState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 13, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 13, keyDown: false) else {
        emit(["ok": false, "why": "keys"]); return
    }
    down.flags = .maskCommand // kVK_ANSI_W, Command only.
    up.flags = .maskCommand
    // This is the post that already closes a tab when the browser is front. Sending it to the pid
    // instead is ignored by some browsers, so the key stays on the HID tap and only goes out now.
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    // The process used to exit before a posted key was delivered.
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2))
    emit(["ok": true, "why": ""])
}

func restoreFocus(owner: Int32, previous: Int32) {
    // A dismissed text panel returns to the previous app, unless the user already switched.
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == owner,
          previous != owner, let target = NSRunningApplication(processIdentifier: previous),
          target.activationPolicy == .regular, !target.isTerminated else {
        emit(["ok": false]); return
    }
    emit(["ok": target.activate(options: [.activateIgnoringOtherApps])])
}

func watch(windowID: Int, parent: Int32) {
    var previous = Data()
    // The title read talks to another process. Doing it on every move makes her perch lag
    // behind the window, so geometry updates on its own and the title refreshes about once a second.
    var title = ""
    var bundle = ""
    var trusted = false
    var titleFg = -1
    var titleAt = Date.distantPast
    while kill(parent, 0) == 0 {
        autoreleasepool {
            var value = windowGeometry(excluding: windowID)
            let fg = value["fg"] as? Int ?? 0
            if fg != titleFg || Date().timeIntervalSince(titleAt) >= 1 {
                let front = frontInfo()
                title = front.title
                bundle = front.bundle
                trusted = front.trusted
                titleFg = fg
                titleAt = Date()
            }
            value["trusted"] = trusted
            if trusted {
                value["title"] = title
                value["bundle"] = bundle
            }
            if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data != previous {
                emitJSON(data)
                previous = data
            }
        }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.08))
    }
}

func closeApp(_ id: String, force: Bool) {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: id).filter(closable)
    for app in apps {
        if force { app.forceTerminate() } else { app.terminate() }
    }
    // Normal termination lets the target app ask to save unsaved work.
    RunLoop.current.run(until: Date(timeIntervalSinceNow: force ? 0.6 : 2.5))
    emit(["running": !NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty])
}

func media(_ action: String) {
    let keys: [String: Int] = ["play": 16, "pause": 16, "next": 17, "previous": 18,
                               "volup": 0, "voldown": 1, "mute": 7]
    guard let key = keys[action] else { emit(["ok": false]); return }
    // Request access only when the user actually asks to control media.
    let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    guard AXIsProcessTrustedWithOptions(prompt) else {
        emit(["ok": false, "error": "accessibility"]); return
    }
    for _ in 0..<(action == "volup" || action == "voldown" ? 5 : 1) {
        for state in [0xA, 0xB] {
            let event = NSEvent.otherEvent(with: .systemDefined, location: .zero,
                modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(state << 8)),
                timestamp: 0, windowNumber: 0, context: nil, subtype: 8,
                data1: (key << 16) | (state << 8), data2: -1)
            event?.cgEvent?.post(tap: .cghidEventTap)
        }
    }
    emit(["ok": true])
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "watch" where args.count == 3:
    if let id = Int(args[1]), let parent = Int32(args[2]), parent > 0 { watch(windowID: id, parent: parent) }
case "snapshot": emit(snapshot(excluding: Int(args.dropFirst().first ?? "0") ?? 0))
case "apps": emit(runningApps())
case "installed": emit(installedApps())
case "restore-focus" where args.count == 3:
    if let owner = Int32(args[1]), let previous = Int32(args[2]), owner > 0, previous > 0 {
        restoreFocus(owner: owner, previous: previous)
    }
case "close" where args.count == 3: closeApp(args[1], force: args[2] == "force")
case "focus" where args.count == 2:
    focus(pid: Int32(args[1]) ?? 0)
case "close-tab":
    closeTab(pid: Int32(args.count > 1 ? args[1] : "0") ?? 0)
case "media" where args.count == 2: media(args[1])
default:
    fputs("Unknown Capri helper command\n", stderr)
    exit(1)
}
