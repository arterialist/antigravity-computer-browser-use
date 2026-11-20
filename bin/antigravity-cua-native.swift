import Cocoa
import ApplicationServices
import CoreGraphics
import ColorSync
import QuartzCore
import Foundation

// MARK: - JSON-RPC / CLI Helper for Antigravity Computer Use
// Provides:
// 1. Multi-Monitor Physical Display Enumeration & Geometry (`listDisplays`, `displayForPoint`)
// 2. Off-Space & On-Space AXWindow Tree Walker (`walkAxTree`) via kAXWindowsAttribute + kAXMainWindowAttribute + kAXFocusedWindowAttribute
// 3. Direct cached AXUIElement actions by `element_index` (`clickElement`, `setValue`, `selectText`, `performSecondaryAction`) that work across macOS Spaces and monitors
// 4. Rich Pasteboard (HTML + Markdown + Plain Text write with snapshot & restore)
// 5. Multi-Monitor Aurora Neon/Material Agent Cursor & Desktop HUD Overlay (`OverlayController`)

struct RPCRequest: Decodable {
    let id: Int?
    let method: String
    let params: [String: AnyCodable]?
}

struct AnyCodable: Codable {
    let value: Any
    init(_ value: Any) { self.value = value }
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let v = try? container.decode(Bool.self) { value = v }
        else if let v = try? container.decode(Int.self) { value = v }
        else if let v = try? container.decode(Double.self) { value = v }
        else if let v = try? container.decode(String.self) { value = v }
        else if let v = try? container.decode([AnyCodable].self) { value = v.map { $0.value } }
        else if let v = try? container.decode([String: AnyCodable].self) { value = v.mapValues { $0.value } }
        else { value = NSNull() }
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let v as Bool: try container.encode(v)
        case let v as Int: try container.encode(v)
        case let v as Double: try container.encode(v)
        case let v as String: try container.encode(v)
        case let v as [Any]: try container.encode(v.map { AnyCodable($0) })
        case let v as [String: Any]: try container.encode(v.mapValues { AnyCodable($0) })
        default: try container.encodeNil()
        }
    }
    var stringValue: String? { value as? String }
    var intValue: Int? {
        if let i = value as? Int { return i }
        if let d = value as? Double { return Int(d) }
        if let s = value as? String { return Int(s) }
        return nil
    }
    var doubleValue: Double? {
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        return nil
    }
    var boolValue: Bool? { value as? Bool }
}

// MARK: - Multi-Monitor Display Geometry

func screenDisplayID(_ screen: NSScreen) -> CGDirectDisplayID {
    if let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
        return CGDirectDisplayID(num.uint32Value)
    }
    return CGMainDisplayID()
}

func primaryScreenHeight() -> CGFloat {
    let mainID = CGMainDisplayID()
    for s in NSScreen.screens {
        if screenDisplayID(s) == mainID {
            return s.frame.height
        }
    }
    return NSScreen.screens.first?.frame.height ?? 1080
}

/// Converts a top-left global CGEvent / Quartz point `(gx, gy)` into Cocoa's global bottom-left `NSPoint`
func quartzToCocoaGlobalPoint(gx: Double, gy: Double) -> NSPoint {
    let h0 = primaryScreenHeight()
    return NSPoint(x: CGFloat(gx), y: h0 - CGFloat(gy))
}

func listPhysicalDisplays() -> [String: Any] {
    let mainID = CGMainDisplayID()
    var displays: [[String: Any]] = []
    for (idx, screen) in NSScreen.screens.enumerated() {
        let did = screenDisplayID(screen)
        let cgBounds = CGDisplayBounds(did)
        let scale = screen.backingScaleFactor
        let name: String
        if #available(macOS 10.15, *) {
            name = screen.localizedName
        } else {
            name = "Display \(idx + 1)"
        }
        displays.append([
            "index": idx,
            "displayId": Int(did),
            "label": name,
            "isMain": did == mainID,
            "isBuiltin": CGDisplayIsBuiltin(did) != 0,
            "originX": Int(cgBounds.origin.x),
            "originY": Int(cgBounds.origin.y),
            "width": Int(cgBounds.width),
            "height": Int(cgBounds.height),
            "physicalWidth": Int(cgBounds.width * scale),
            "physicalHeight": Int(cgBounds.height * scale),
            "scaleFactor": Double(scale),
            "rotation": CGDisplayRotation(did)
        ])
    }
    return [
        "ok": true,
        "count": displays.count,
        "mainDisplayId": Int(mainID),
        "displays": displays
    ]
}

// Cache of live AXUIElement references per bundleId from the latest `walkAxTree` call
var cachedAxElementsByApp: [String: [AXUIElement]] = [:]

struct CachedAxSnapshot {
    let pid: pid_t
    let epoch: UInt64
    let timestamp: CFTimeInterval
    let windowBounds: [String: Any]
    let displayId: Int
    let summary: [[String: Any]]
}

let axCacheLock = NSLock()
var cachedAxSnapshotByApp: [String: CachedAxSnapshot] = [:]
var axMutationEpochByPid: [pid_t: UInt64] = [:]
var axLastMutationTimeByPid: [pid_t: CFTimeInterval] = [:]
var axObserversByPid: [pid_t: AXObserver] = [:]

func bumpAxMutation(pid: pid_t) {
    axCacheLock.lock()
    axMutationEpochByPid[pid] = (axMutationEpochByPid[pid] ?? 0) &+ 1
    axLastMutationTimeByPid[pid] = CACurrentMediaTime()
    axCacheLock.unlock()
}

let axObserverCallback: AXObserverCallback = { (_, element, _, _) in
    var pid: pid_t = 0
    if AXUIElementGetPid(element, &pid) == .success, pid > 0 {
        bumpAxMutation(pid: pid)
    }
}

func ensureAXObserver(for pid: pid_t) {
    axCacheLock.lock()
    let alreadyRegistered = axObserversByPid[pid] != nil
    axCacheLock.unlock()
    if alreadyRegistered { return }

    var observer: AXObserver?
    guard AXObserverCreate(pid, axObserverCallback, &observer) == .success,
          let obs = observer else { return }

    let appElem = AXUIElementCreateApplication(pid)
    let notifications = [
        kAXFocusedUIElementChangedNotification,
        kAXValueChangedNotification,
        kAXUIElementDestroyedNotification,
        kAXTitleChangedNotification,
        kAXMainWindowChangedNotification,
        kAXFocusedWindowChangedNotification,
        kAXWindowMovedNotification,
        kAXWindowResizedNotification
    ]
    for notif in notifications {
        AXObserverAddNotification(obs, appElem, notif as CFString, nil)
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)

    axCacheLock.lock()
    axObserversByPid[pid] = obs
    if axMutationEpochByPid[pid] == nil {
        axMutationEpochByPid[pid] = 1
    }
    axCacheLock.unlock()
}

func waitForAdaptiveSettle(pid: pid_t, maxWaitMs: Int = 90, quietWindowMs: Int = 28) -> Int {
    guard maxWaitMs > 0 else { return 0 }
    let start = CACurrentMediaTime()
    let maxSec = Double(min(maxWaitMs, 400)) / 1000.0
    let quietSec = Double(max(10, quietWindowMs)) / 1000.0
    while (CACurrentMediaTime() - start) < maxSec {
        axCacheLock.lock()
        let lastMut = axLastMutationTimeByPid[pid] ?? 0
        axCacheLock.unlock()
        if lastMut == 0 || (CACurrentMediaTime() - lastMut) >= quietSec {
            break
        }
        usleep(10_000) // 10ms poll
    }
    return Int(((CACurrentMediaTime() - start) * 1000.0).rounded())
}

func findRunningApp(identifier: String) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications
    if let exact = apps.first(where: { $0.bundleIdentifier?.lowercased() == identifier.lowercased() }) {
        return exact
    }
    if let byName = apps.first(where: { $0.localizedName?.lowercased() == identifier.lowercased() }) {
        return byName
    }
    if let partial = apps.first(where: {
        ($0.localizedName?.lowercased().contains(identifier.lowercased()) ?? false) ||
        ($0.bundleIdentifier?.lowercased().contains(identifier.lowercased()) ?? false)
    }) {
        return partial
    }
    return nil
}

func getAXString(_ el: AXUIElement, _ attr: String) -> String? {
    var ref: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success, let s = ref as? String, !s.isEmpty {
        return s
    }
    return nil
}

func getAXPoint(_ el: AXUIElement) -> CGPoint? {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &ref) == .success,
          let val = ref else { return nil }
    var pt = CGPoint.zero
    if AXValueGetValue(val as! AXValue, .cgPoint, &pt) {
        return pt
    }
    return nil
}

func getAXSize(_ el: AXUIElement) -> CGSize? {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &ref) == .success,
          let val = ref else { return nil }
    var sz = CGSize.zero
    if AXValueGetValue(val as! AXValue, .cgSize, &sz) {
        return sz
    }
    return nil
}

let INTERACTIVE_ROLES: Set<String> = [
    "AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox", "AXRadioButton",
    "AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField", "AXComboBox",
    "AXLink", "AXTabGroup", "AXTab", "AXSlider", "AXIncrementor", "AXDisclosureTriangle",
    "AXMenuItem", "AXMenuBarItem", "AXRow", "AXCell", "AXStaticText", "AXImage",
    "AXHeading", "AXWebArea", "AXColorWell", "AXOutlineRow", "AXValueIndicator"
]

func findMainOrFirstAXWindow(axApp: AXUIElement) -> AXUIElement? {
    var mainRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &mainRef) == .success,
       let mw = mainRef {
        let win = (mw as! AXUIElement)
        if let sz = getAXSize(win), sz.height >= 80 {
            return win
        }
    }
    var focRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &focRef) == .success,
       let fw = focRef {
        let win = (fw as! AXUIElement)
        if let sz = getAXSize(win), sz.height >= 80 {
            return win
        }
    }
    var winsRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winsRef) == .success,
       let wins = winsRef as? [AXUIElement], !wins.isEmpty {
        if let stdWin = wins.first(where: {
            let sub = getAXString($0, kAXSubroleAttribute as String)
            let h = getAXSize($0)?.height ?? 0
            return (sub == "AXStandardWindow" && h >= 80) || h >= 120
        }) {
            return stdWin
        }
        return wins[0]
    }
    if let mw = mainRef { return (mw as! AXUIElement) }
    if let fw = focRef { return (fw as! AXUIElement) }
    return nil
}

func walkWindowAxTree(params: [String: AnyCodable]) -> [String: Any] {
    guard let appId = params["app"]?.stringValue else {
        return ["ok": false, "error": "app is required"]
    }
    guard let app = findRunningApp(identifier: appId) else {
        return ["ok": false, "error": "Application not running: \(appId)"]
    }
    let pid = app.processIdentifier
    let bundleId = app.bundleIdentifier ?? appId
    let cacheKey = bundleId.lowercased()
    let forceRefresh = params["forceRefresh"]?.boolValue ?? false
    let settleWaitMs = params["settleWaitMs"]?.intValue ?? 0

    ensureAXObserver(for: pid)
    var settledMs = 0
    if settleWaitMs > 0 {
        settledMs = waitForAdaptiveSettle(pid: pid, maxWaitMs: settleWaitMs)
    }

    // Fast path: return cached AX snapshot if no UI mutation occurred on this PID
    axCacheLock.lock()
    let currentEpoch = axMutationEpochByPid[pid] ?? 1
    let existingCache = cachedAxSnapshotByApp[cacheKey]
    axCacheLock.unlock()

    let now = CACurrentMediaTime()
    if !forceRefresh,
       let cached = existingCache,
       cached.pid == pid,
       cached.epoch == currentEpoch,
       (now - cached.timestamp) < 1.8,
       !cached.summary.isEmpty {
        return [
            "ok": true,
            "bundleId": bundleId,
            "displayId": cached.displayId,
            "windowBounds": cached.windowBounds,
            "axSummary": cached.summary,
            "cached": true,
            "settledMs": settledMs
        ]
    }

    let appElem = AXUIElementCreateApplication(pid)
    AXUIElementSetAttributeValue(appElem, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(appElem, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)

    guard let winEl = findMainOrFirstAXWindow(axApp: appElem) else {
        return ["ok": false, "error": "No AXWindow available for \(bundleId)"]
    }

    let winPos = getAXPoint(winEl) ?? .zero
    let winSize = getAXSize(winEl) ?? CGSize(width: 1200, height: 800)

    var summary: [[String: Any]] = []
    var elementRefs: [AXUIElement] = []
    let maxNodes = params["maxNodes"]?.intValue ?? 250
    var visited = 0

    let parentLabelRoles: Set<String> = [
        "AXHeading", "AXLink", "AXButton", "AXTab", "AXMenuItem", "AXMenuBarItem", "AXPopUpButton", "AXRadioButton", "AXCheckBox"
    ]

    func dfs(_ el: AXUIElement, depth: Int, parentLabel: String?) {
        if summary.count >= maxNodes || visited > 2500 || depth > 28 { return }
        visited += 1

        let role = getAXString(el, kAXRoleAttribute as String) ?? ""
        let subrole = getAXString(el, kAXSubroleAttribute as String)
        let title = getAXString(el, kAXTitleAttribute as String)
            ?? getAXString(el, kAXDescriptionAttribute as String)
            ?? getAXString(el, kAXHelpAttribute as String)
        var valStr: String? = nil
        var valRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &valRef) == .success {
            if let s = valRef as? String, !s.isEmpty {
                valStr = String(s.prefix(120))
            } else if let n = valRef as? NSNumber {
                valStr = n.stringValue
            }
        }

        // Deduplicate redundant child AXStaticText when its text already appears on its interactive parent
        let effectiveText = (valStr ?? title)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if role == "AXStaticText",
           let pLabel = parentLabel,
           let eText = effectiveText,
           !eText.isEmpty,
           pLabel == eText {
            return
        }

        if let pos = getAXPoint(el), let sz = getAXSize(el), sz.width > 1, sz.height > 1 {
            let isInteractive = INTERACTIVE_ROLES.contains(role)
            let hasLabel = (title != nil && !title!.isEmpty) || (valStr != nil && !valStr!.isEmpty)
            if isInteractive && (role != "AXStaticText" || hasLabel) {
                var actionsList: [String] = []
                var actRef: CFArray?
                if AXUIElementCopyActionNames(el, &actRef) == .success, let acts = actRef as? [String] {
                    actionsList = acts.filter { act in
                        if act == "AXScrollToVisible" || act == "AXShowDefaultUI" { return false }
                        // Strip noisy internal macOS NSToolbar debug action strings containing newlines or Selector:(null)
                        if act.contains("\n") || act.contains("Selector:") || act.contains("Target:0x") { return false }
                        // Omit noisy AXShowMenu on static text, headings, and web areas
                        if act == "AXShowMenu" && (role == "AXStaticText" || role == "AXHeading" || role == "AXWebArea" || role == "AXLink") {
                            return false
                        }
                        return true
                    }
                }
                var item: [String: Any] = [
                    "role": role,
                    "x": pos.x,
                    "y": pos.y,
                    "w": sz.width,
                    "h": sz.height
                ]
                if let sr = subrole { item["subrole"] = sr }
                let trimmedTitle = title.map { String($0.prefix(120)) }
                if let t = trimmedTitle { item["title"] = t }
                if let v = valStr, v != trimmedTitle { item["value"] = v }
                if !actionsList.isEmpty { item["actions"] = actionsList }
                summary.append(item)
                elementRefs.append(el)
            }
        }

        let nextParentLabel: String?
        if parentLabelRoles.contains(role), let lbl = effectiveText, !lbl.isEmpty {
            nextParentLabel = lbl
        } else {
            nextParentLabel = parentLabel
        }

        var chRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &chRef) == .success,
           let children = chRef as? [AXUIElement] {
            for child in children {
                if summary.count >= maxNodes { break }
                dfs(child, depth: depth + 1, parentLabel: nextParentLabel)
            }
        }
    }

    dfs(winEl, depth: 0, parentLabel: nil)
    cachedAxElementsByApp[cacheKey] = elementRefs

    // Identify which physical display hosts this window
    let centerPt = CGPoint(x: winPos.x + winSize.width / 2, y: winPos.y + winSize.height / 2)
    var hostDisplayId = Int(CGMainDisplayID())
    for s in NSScreen.screens {
        let did = screenDisplayID(s)
        if CGDisplayBounds(did).contains(centerPt) {
            hostDisplayId = Int(did)
            break
        }
    }

    let boundsDict: [String: Any] = [
        "x": winPos.x,
        "y": winPos.y,
        "w": winSize.width,
        "h": winSize.height
    ]

    axCacheLock.lock()
    let savedEpoch = axMutationEpochByPid[pid] ?? 1
    cachedAxSnapshotByApp[cacheKey] = CachedAxSnapshot(
        pid: pid,
        epoch: savedEpoch,
        timestamp: CACurrentMediaTime(),
        windowBounds: boundsDict,
        displayId: hostDisplayId,
        summary: summary
    )
    axCacheLock.unlock()

    return [
        "ok": true,
        "bundleId": bundleId,
        "displayId": hostDisplayId,
        "windowBounds": boundsDict,
        "axSummary": summary,
        "cached": false,
        "settledMs": settledMs
    ]
}

func resolveAXElement(pid: pid_t, bundleId: String?, elementIndex: Int?, screenX: Double?, screenY: Double?) -> AXUIElement? {
    if let b = bundleId?.lowercased(), let idx = elementIndex,
       let list = cachedAxElementsByApp[b], idx >= 0 && idx < list.count {
        return list[idx]
    }
    let appElem = AXUIElementCreateApplication(pid)
    if let x = screenX, let y = screenY {
        var hitElem: AXUIElement?
        let sysWide = AXUIElementCreateSystemWide()
        if AXUIElementCopyElementAtPosition(sysWide, Float(x), Float(y), &hitElem) == .success, let hit = hitElem {
            var hitPid: pid_t = 0
            AXUIElementGetPid(hit, &hitPid)
            if hitPid == pid {
                return hit
            }
        }
        if AXUIElementCopyElementAtPosition(appElem, Float(x), Float(y), &hitElem) == .success, let hit = hitElem {
            return hit
        }
    }
    var focused: CFTypeRef?
    if AXUIElementCopyAttributeValue(appElem, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
       let elem = focused {
        return (elem as! AXUIElement)
    }
    return nil
}

func findEditableSelfOrAncestor(_ start: AXUIElement) -> AXUIElement {
    var curr: AXUIElement? = start
    for _ in 0..<8 {
        guard let el = curr else { break }
        var val: CFTypeRef?
        var settable: DarwinBoolean = false
        if AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue {
            return el
        }
        if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &val) == .success, val is String {
            return el
        }
        var parent: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &parent) == .success, let p = parent {
            curr = (p as! AXUIElement)
        } else {
            break
        }
    }
    return start
}

func performClickElement(params: [String: AnyCodable]) -> [String: Any] {
    guard let appId = params["app"]?.stringValue else {
        return ["ok": false, "error": "app is required"]
    }
    guard let app = findRunningApp(identifier: appId) else {
        return ["ok": false, "error": "Application not running: \(appId)"]
    }
    let elIdx = params["element_index"]?.intValue
    let sx = params["screenX"]?.doubleValue
    let sy = params["screenY"]?.doubleValue
    guard let rawEl = resolveAXElement(pid: app.processIdentifier, bundleId: app.bundleIdentifier ?? appId, elementIndex: elIdx, screenX: sx, screenY: sy) else {
        return ["ok": false, "error": "Could not resolve target AXUIElement"]
    }
    let role = getAXString(rawEl, kAXRoleAttribute as String) ?? "AXElement"
    let title = getAXString(rawEl, kAXTitleAttribute as String) ?? getAXString(rawEl, kAXDescriptionAttribute as String)

    // Determine center of element for the Agent Cursor animation
    var targetGlobalPt: CGPoint? = nil
    if let pos = getAXPoint(rawEl), let sz = getAXSize(rawEl) {
        targetGlobalPt = CGPoint(x: pos.x + sz.width / 2.0, y: pos.y + sz.height / 2.0)
    } else if let x = sx, let y = sy {
        targetGlobalPt = CGPoint(x: x, y: y)
    }

    if let pt = targetGlobalPt {
        let labelStr = "\(app.localizedName ?? appId) · \(title ?? role)"
        DispatchQueue.main.async {
            OverlayController.shared.showStatus(
                mode: "background",
                label: "Antigravity Agent · \(labelStr)",
                cursorLabel: labelStr,
                targetGlobalX: Double(pt.x),
                targetGlobalY: Double(pt.y),
                isClick: true,
                tooltip: nil,
                durationMs: 3200
            )
        }
    }

    var curr: AXUIElement? = rawEl
    for _ in 0..<5 {
        guard let el = curr else { break }
        let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
        if err == .success {
            bumpAxMutation(pid: app.processIdentifier)
            return ["ok": true, "role": role, "title": title ?? "", "axOp": "AXPress"]
        }
        var parent: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &parent) == .success, let p = parent {
            curr = (p as! AXUIElement)
        } else {
            break
        }
    }
    let focusErr = AXUIElementSetAttributeValue(rawEl, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if focusErr == .success {
        bumpAxMutation(pid: app.processIdentifier)
        return ["ok": true, "role": role, "title": title ?? "", "axOp": "set AXFocused=true"]
    }
    return ["ok": false, "role": role, "error": "AXPress unsupported on element"]
}

func performSelectText(params: [String: AnyCodable]) -> [String: Any] {
    guard let appId = params["app"]?.stringValue,
          let targetText = params["text"]?.stringValue else {
        return ["ok": false, "error": "app and text are required"]
    }
    guard let app = findRunningApp(identifier: appId) else {
        return ["ok": false, "error": "Application not running: \(appId)"]
    }
    let elIdx = params["element_index"]?.intValue
    let sx = params["screenX"]?.doubleValue
    let sy = params["screenY"]?.doubleValue
    guard let rawEl = resolveAXElement(pid: app.processIdentifier, bundleId: app.bundleIdentifier ?? appId, elementIndex: elIdx, screenX: sx, screenY: sy) else {
        return ["ok": false, "error": "Could not resolve target AXUIElement"]
    }
    let el = findEditableSelfOrAncestor(rawEl)
    var valRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &valRef) == .success,
          let fullText = valRef as? String else {
        return ["ok": false, "error": "Target element does not expose a string AXValue"]
    }

    let prefix = params["prefix"]?.stringValue ?? ""
    let suffix = params["suffix"]?.stringValue ?? ""
    let selectionType = params["selection_type"]?.stringValue ?? "text"

    let searchPattern = prefix + targetText + suffix
    let nsFull = fullText as NSString
    let matchRange = nsFull.range(of: searchPattern)
    let finalRange: NSRange
    if matchRange.location != NSNotFound {
        let prefixLen = (prefix as NSString).length
        let targetLen = (targetText as NSString).length
        finalRange = NSRange(location: matchRange.location + prefixLen, length: targetLen)
    } else {
        let fallback = nsFull.range(of: targetText)
        if fallback.location == NSNotFound {
            return ["ok": false, "error": "Target text '\(targetText)' not found inside element value"]
        }
        finalRange = fallback
    }

    var cfRange: CFRange
    switch selectionType {
    case "cursor_before":
        cfRange = CFRange(location: finalRange.location, length: 0)
    case "cursor_after":
        cfRange = CFRange(location: finalRange.location + finalRange.length, length: 0)
    default:
        cfRange = CFRange(location: finalRange.location, length: finalRange.length)
    }

    AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard let axVal = AXValueCreate(.cfRange, &cfRange) else {
        return ["ok": false, "error": "Failed to construct AXValue CFRange"]
    }
    let err = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, axVal)
    if err != .success {
        return ["ok": false, "error": "AXUIElementSetAttributeValue(AXSelectedTextRange) failed with code \(err.rawValue)"]
    }
    return [
        "ok": true,
        "location": cfRange.location,
        "length": cfRange.length,
        "selectionType": selectionType
    ]
}

func performSetValue(params: [String: AnyCodable]) -> [String: Any] {
    guard let appId = params["app"]?.stringValue,
          let newValue = params["value"]?.stringValue else {
        return ["ok": false, "error": "app and value are required"]
    }
    guard let app = findRunningApp(identifier: appId) else {
        return ["ok": false, "error": "Application not running: \(appId)"]
    }
    let elIdx = params["element_index"]?.intValue
    let sx = params["screenX"]?.doubleValue
    let sy = params["screenY"]?.doubleValue
    guard let rawEl = resolveAXElement(pid: app.processIdentifier, bundleId: app.bundleIdentifier ?? appId, elementIndex: elIdx, screenX: sx, screenY: sy) else {
        return ["ok": false, "error": "Could not resolve target AXUIElement"]
    }
    let el = findEditableSelfOrAncestor(rawEl)
    if let pos = getAXPoint(el), let sz = getAXSize(el) {
        let pt = CGPoint(x: pos.x + sz.width / 2.0, y: pos.y + sz.height / 2.0)
        DispatchQueue.main.async {
            OverlayController.shared.showStatus(
                mode: "background",
                label: "Antigravity Agent · Typing in \(app.localizedName ?? appId)",
                cursorLabel: "\(app.localizedName ?? appId) · Type",
                targetGlobalX: Double(pt.x),
                targetGlobalY: Double(pt.y),
                isClick: true,
                tooltip: nil,
                durationMs: 3200
            )
        }
    }
    AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let mode = params["mode"]?.stringValue ?? "replace"
    if mode == "insert" {
        let selErr = AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, newValue as CFTypeRef)
        if selErr == .success {
            bumpAxMutation(pid: app.processIdentifier)
            return ["ok": true, "axOp": "set AXSelectedText"]
        }
    }
    let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, newValue as CFTypeRef)
    if err != .success {
        return ["ok": false, "error": "AXUIElementSetAttributeValue(AXValue) failed with code \(err.rawValue)"]
    }
    bumpAxMutation(pid: app.processIdentifier)
    return ["ok": true, "axOp": "set AXValue"]
}

func performSecondaryAction(params: [String: AnyCodable]) -> [String: Any] {
    guard let appId = params["app"]?.stringValue,
          let actionName = params["action"]?.stringValue else {
        return ["ok": false, "error": "app and action are required"]
    }
    guard let app = findRunningApp(identifier: appId) else {
        return ["ok": false, "error": "Application not running: \(appId)"]
    }
    let elIdx = params["element_index"]?.intValue
    let sx = params["screenX"]?.doubleValue
    let sy = params["screenY"]?.doubleValue
    guard let rawEl = resolveAXElement(pid: app.processIdentifier, bundleId: app.bundleIdentifier ?? appId, elementIndex: elIdx, screenX: sx, screenY: sy) else {
        return ["ok": false, "error": "Could not resolve target AXUIElement"]
    }

    let actionMap: [String: String] = [
        "press": kAXPressAction as String,
        "click": kAXPressAction as String,
        "show menu": kAXShowMenuAction as String,
        "showmenu": kAXShowMenuAction as String,
        "axshowmenu": kAXShowMenuAction as String,
        "increment": kAXIncrementAction as String,
        "axincrement": kAXIncrementAction as String,
        "decrement": kAXDecrementAction as String,
        "axdecrement": kAXDecrementAction as String,
        "confirm": kAXConfirmAction as String,
        "axconfirm": kAXConfirmAction as String,
        "cancel": kAXCancelAction as String,
        "axcancel": kAXCancelAction as String,
        "raise": kAXRaiseAction as String,
        "axraise": kAXRaiseAction as String,
        "pick": kAXPickAction as String,
        "axpick": kAXPickAction as String
    ]
    let normalized = actionMap[actionName.lowercased().trimmingCharacters(in: .whitespaces)] ?? actionName

    var curr: AXUIElement? = rawEl
    for _ in 0..<6 {
        guard let el = curr else { break }
        var actionsRef: CFArray?
        if AXUIElementCopyActionNames(el, &actionsRef) == .success,
           let actions = actionsRef as? [String] {
            if let matched = actions.first(where: { $0.lowercased() == normalized.lowercased() || $0.lowercased() == ("ax" + normalized.lowercased()) }) {
                let err = AXUIElementPerformAction(el, matched as CFString)
                if err == .success { bumpAxMutation(pid: app.processIdentifier) }
                return ["ok": err == .success, "action": matched, "axError": err.rawValue]
            }
        }
        var parent: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &parent) == .success, let p = parent {
            curr = (p as! AXUIElement)
        } else {
            break
        }
    }
    let fallbackErr = AXUIElementPerformAction(rawEl, normalized as CFString)
    if fallbackErr == .success { bumpAxMutation(pid: app.processIdentifier) }
    return ["ok": fallbackErr == .success, "action": normalized, "axError": fallbackErr.rawValue]
}

// MARK: - Cross-Display & Cross-Space Window Movement (SkyLight + AXPosition)

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ windowId: UnsafeMutablePointer<CGWindowID>) -> AXError

func resolveTargetDisplay(query: Any?) -> (displayId: CGDirectDisplayID, label: String, bounds: CGRect, uuid: String)? {
    let screens = NSScreen.screens
    guard !screens.isEmpty else { return nil }
    var matchedScreen: NSScreen? = nil

    if let qInt = query as? Int {
        for (idx, s) in screens.enumerated() {
            let did = screenDisplayID(s)
            if Int(did) == qInt || idx == qInt {
                matchedScreen = s
                break
            }
        }
    } else if let qStr = (query as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !qStr.isEmpty {
        let lower = qStr.lowercased()
        for (idx, s) in screens.enumerated() {
            let did = screenDisplayID(s)
            let name = s.localizedName.lowercased()
            if String(did) == lower || String(idx) == lower || name == lower || name.contains(lower) {
                matchedScreen = s
                break
            }
            if (lower == "external" || lower == "secondary") && CGDisplayIsBuiltin(did) == 0 {
                matchedScreen = s
                break
            }
            if (lower == "builtin" || lower == "main" || lower == "primary") && CGDisplayIsBuiltin(did) != 0 {
                matchedScreen = s
                break
            }
        }
    }

    let screen = matchedScreen ?? screens.first(where: { CGDisplayIsBuiltin(screenDisplayID($0)) == 0 }) ?? screens[0]
    let did = screenDisplayID(screen)
    let bounds = CGDisplayBounds(did)
    var uuidStr = ""
    if let uuidRef = CGDisplayCreateUUIDFromDisplayID(did)?.takeRetainedValue() {
        uuidStr = (CFUUIDCreateString(nil, uuidRef) as String?) ?? ""
    }
    return (did, screen.localizedName, bounds, uuidStr)
}

func moveWindowToDisplayAndDesktopSpace(params: [String: AnyCodable]) -> [String: Any] {
    guard let appId = params["app"]?.stringValue else {
        return ["ok": false, "error": "app parameter is required"]
    }
    guard let app = findRunningApp(identifier: appId) else {
        return ["ok": false, "error": "Application not running: \(appId)"]
    }
    let displayQuery = params["display"]?.value
    guard let targetDisp = resolveTargetDisplay(query: displayQuery) else {
        return ["ok": false, "error": "No target display found"]
    }
    let switchToDesktopSpace = params["switch_to_desktop"]?.boolValue ?? true
    let explicitSpaceId = params["space_id"]?.intValue
    let useOtherSpace = params["other_space"]?.boolValue ?? false

    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    guard let axWin = findMainOrFirstAXWindow(axApp: axApp) else {
        return ["ok": false, "error": "No AXWindow found for \(app.localizedName ?? appId)"]
    }

    var winId: CGWindowID = 0
    _ = _AXUIElementGetWindow(axWin, &winId)
    if let explicitWid = params["window_id"]?.intValue, explicitWid > 0 {
        winId = CGWindowID(explicitWid)
    }

    let beforePos = getAXPoint(axWin) ?? .zero
    let winSize = getAXSize(axWin) ?? CGSize(width: 400, height: 500)
    let targetX = params["x"]?.doubleValue ?? Double(targetDisp.bounds.origin.x + (targetDisp.bounds.width - winSize.width) / 2.0)
    let targetY = params["y"]?.doubleValue ?? Double(targetDisp.bounds.origin.y + (targetDisp.bounds.height - winSize.height) / 2.0)

    var newPt = CGPoint(x: targetX, y: targetY)
    var axMoveErr: Int32 = -1
    if let val = AXValueCreate(.cgPoint, &newPt) {
        axMoveErr = AXUIElementSetAttributeValue(axWin, kAXPositionAttribute as CFString, val).rawValue
    }

    var desktopSpaceId: UInt64 = 0
    var previousSpaceId: UInt64 = 0
    var switchedDisplaySpace = false
    var availableSpacesOnDisplay: [[String: Any]] = []

    if let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/SkyLight", RTLD_NOW) {
        typealias MainConnFn = @convention(c) () -> Int32
        typealias CopyManagedFn = @convention(c) (Int32) -> CFArray
        typealias MoveToSpaceFn = @convention(c) (Int32, CFArray, UInt64) -> Void
        typealias SetCurrentSpaceFn = @convention(c) (Int32, CFString, UInt64) -> Void
        typealias ShowSpacesFn = @convention(c) (Int32, CFArray) -> Void
        typealias HideSpacesFn = @convention(c) (Int32, CFArray) -> Void

        if let mainConnSym = dlsym(handle, "SLSMainConnectionID"),
           let copyManagedSym = dlsym(handle, "SLSCopyManagedDisplaySpaces") {
            let cid = unsafeBitCast(mainConnSym, to: MainConnFn.self)()
            let copyManaged = unsafeBitCast(copyManagedSym, to: CopyManagedFn.self)
            if let managedList = copyManaged(cid) as? [[String: Any]] {
                for dispEntry in managedList {
                    let entryUUID = (dispEntry["Display Identifier"] as? String) ?? ""
                    if entryUUID.uppercased() == targetDisp.uuid.uppercased() || managedList.count == 1 {
                        if let curr = dispEntry["Current Space"] as? [String: Any],
                           let cid64 = (curr["id64"] as? NSNumber)?.uint64Value ?? (curr["ManagedSpaceID"] as? NSNumber)?.uint64Value {
                            previousSpaceId = cid64
                        }
                        if let spaces = dispEntry["Spaces"] as? [[String: Any]] {
                            for s in spaces {
                                let sid = (s["id64"] as? NSNumber)?.uint64Value ?? (s["ManagedSpaceID"] as? NSNumber)?.uint64Value ?? 0
                                let stype = (s["type"] as? NSNumber)?.intValue ?? 0
                                let suuid = (s["uuid"] as? String) ?? ""
                                availableSpacesOnDisplay.append(["spaceId": sid, "type": stype, "uuid": suuid, "isCurrent": sid == previousSpaceId])
                            }
                            if let exp = explicitSpaceId, exp > 0 {
                                desktopSpaceId = UInt64(exp)
                            } else if useOtherSpace {
                                // Pick the other Space on that monitor (i.e. not previousSpaceId)
                                if let alt = spaces.first(where: {
                                    let sid = ($0["id64"] as? NSNumber)?.uint64Value ?? ($0["ManagedSpaceID"] as? NSNumber)?.uint64Value ?? 0
                                    return sid != 0 && sid != previousSpaceId
                                }) {
                                    desktopSpaceId = (alt["id64"] as? NSNumber)?.uint64Value ?? (alt["ManagedSpaceID"] as? NSNumber)?.uint64Value ?? 0
                                }
                            }
                            if desktopSpaceId == 0 {
                                // Prefer standard Desktop space (type == 0) on that monitor
                                if let desk = spaces.first(where: { (($0["type"] as? NSNumber)?.intValue ?? -1) == 0 }),
                                   let sid = (desk["id64"] as? NSNumber)?.uint64Value ?? (desk["ManagedSpaceID"] as? NSNumber)?.uint64Value {
                                    desktopSpaceId = sid
                                } else if let first = spaces.first,
                                          let sid = (first["id64"] as? NSNumber)?.uint64Value ?? (first["ManagedSpaceID"] as? NSNumber)?.uint64Value {
                                    desktopSpaceId = sid
                                }
                            }
                        }
                        break
                    }
                }
            }

            if desktopSpaceId > 0 {
                if winId > 0, let moveSym = dlsym(handle, "SLSMoveWindowsToManagedSpace") {
                    let moveFn = unsafeBitCast(moveSym, to: MoveToSpaceFn.self)
                    moveFn(cid, [NSNumber(value: winId)] as CFArray, desktopSpaceId)
                }
                if switchToDesktopSpace && previousSpaceId != 0 && previousSpaceId != desktopSpaceId && !targetDisp.uuid.isEmpty {
                    if let showSym = dlsym(handle, "SLSShowSpaces"),
                       let setSym = dlsym(handle, "SLSManagedDisplaySetCurrentSpace"),
                       let hideSym = dlsym(handle, "SLSHideSpaces") {
                        let showFn = unsafeBitCast(showSym, to: ShowSpacesFn.self)
                        let setFn = unsafeBitCast(setSym, to: SetCurrentSpaceFn.self)
                        let hideFn = unsafeBitCast(hideSym, to: HideSpacesFn.self)
                        showFn(cid, [NSNumber(value: desktopSpaceId)] as CFArray)
                        setFn(cid, targetDisp.uuid as CFString, desktopSpaceId)
                        hideFn(cid, [NSNumber(value: previousSpaceId)] as CFArray)
                        switchedDisplaySpace = true
                    }
                }
            }
        }
    }

    // Re-apply AXPosition after Space transition so macOS places it cleanly on the target monitor's Desktop Space
    if let val = AXValueCreate(.cgPoint, &newPt) {
        _ = AXUIElementSetAttributeValue(axWin, kAXPositionAttribute as CFString, val)
    }
    _ = AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)

    let finalPos = getAXPoint(axWin) ?? newPt
    let finalSize = getAXSize(axWin) ?? winSize
    let centerPt = CGPoint(x: finalPos.x + finalSize.width / 2.0, y: finalPos.y + finalSize.height / 2.0)

    let durationMs = params["duration_ms"]?.intValue ?? 3600
    let customLabel = params["label"]?.stringValue ?? "Antigravity Agent · Moved \(app.localizedName ?? appId) to \(targetDisp.label)"
    let customTooltip = params["tooltip"]?.stringValue ?? "Moved \(app.localizedName ?? appId) to Space \(desktopSpaceId) on \(targetDisp.label)"

    DispatchQueue.main.async {
        OverlayController.shared.showStatus(
            mode: "display",
            label: customLabel,
            cursorLabel: "\(app.localizedName ?? appId) · (\(Int(finalPos.x)), \(Int(finalPos.y)))",
            targetGlobalX: Double(centerPt.x),
            targetGlobalY: Double(centerPt.y),
            isClick: params["is_click"]?.boolValue ?? true,
            tooltip: customTooltip,
            durationMs: durationMs
        )
    }

    return [
        "ok": true,
        "app": app.bundleIdentifier ?? appId,
        "displayName": app.localizedName ?? appId,
        "windowId": Int(winId),
        "targetDisplayId": Int(targetDisp.displayId),
        "targetDisplayLabel": targetDisp.label,
        "desktopSpaceId": Int(desktopSpaceId),
        "previousSpaceId": Int(previousSpaceId),
        "availableSpaces": availableSpacesOnDisplay,
        "switchedDisplayToDesktopSpace": switchedDisplaySpace,
        "axMoveError": Int(axMoveErr),
        "beforeBounds": [
            "x": Int(beforePos.x),
            "y": Int(beforePos.y),
            "w": Int(winSize.width),
            "h": Int(winSize.height)
        ],
        "bounds": [
            "x": Int(finalPos.x),
            "y": Int(finalPos.y),
            "w": Int(finalSize.width),
            "h": Int(finalSize.height)
        ]
    ]
}

// MARK: - Rich Pasteboard (HTML / Markdown / Text with Snapshot & Restore)

var savedClipboardItems: [[NSPasteboard.PasteboardType: Data]] = []

func snapshotClipboard() {
    let pb = NSPasteboard.general
    savedClipboardItems.removeAll()
    for item in pb.pasteboardItems ?? [] {
        var dict: [NSPasteboard.PasteboardType: Data] = [:]
        for t in item.types {
            if let d = item.data(forType: t) {
                dict[t] = d
            }
        }
        savedClipboardItems.append(dict)
    }
}

func restoreClipboard() {
    let pb = NSPasteboard.general
    pb.clearContents()
    guard !savedClipboardItems.isEmpty else { return }
    var newItems: [NSPasteboardItem] = []
    for dict in savedClipboardItems {
        let item = NSPasteboardItem()
        for (t, d) in dict {
            item.setData(d, forType: t)
        }
        newItems.append(item)
    }
    pb.writeObjects(newItems)
}

func setRichClipboard(text: String, format: String) -> [String: Any] {
    snapshotClipboard()
    let pb = NSPasteboard.general
    pb.clearContents()
    if format == "html" {
        pb.setString(text, forType: .html)
        let plain = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        pb.setString(plain, forType: .string)
    } else {
        pb.setString(text, forType: .string)
    }
    return ["ok": true, "format": format]
}

// MARK: - Multi-Monitor Aurora Agent Cursor & HUD Overlay

struct CursorTrailSample {
    let point: NSPoint
    let timestamp: CFTimeInterval
}

@MainActor
class OverlayController {
    static let shared = OverlayController()
    private var panelsByDisplay: [CGDirectDisplayID: NSPanel] = [:]
    private var viewsByDisplay: [CGDirectDisplayID: OverlayCanvasView] = [:]
    private var hideTimer: Timer?
    private var frameTimer: Timer?

    // Shared animation state across displays
    var activeDisplayId: CGDirectDisplayID = CGMainDisplayID()
    var activeMode: String = "display"
    var statusLabel: String = "Antigravity Agent · Press Esc to stop"
    var cursorLabel: String = "Antigravity Agent"
    var tooltipText: String? = nil

    // Smooth interpolated Agent Cursor position in view-local coordinates of `activeDisplayId`
    var cursorCurrentPt: NSPoint? = nil
    var cursorStartPt: NSPoint? = nil
    var cursorTargetPt: NSPoint? = nil
    var moveStartTime: CFTimeInterval = 0
    var moveDuration: CFTimeInterval = 0.26
    var trailSamples: [CursorTrailSample] = []

    // Dual-wave neon click ripple state
    var ripplePoint: NSPoint? = nil
    var rippleStartTime: CFTimeInterval = 0
    var rippleActive: Bool = false

    func syncPanelsWithScreens() {
        var seenIds = Set<CGDirectDisplayID>()
        for screen in NSScreen.screens {
            let did = screenDisplayID(screen)
            seenIds.insert(did)
            if let existingPanel = panelsByDisplay[did], let existingView = viewsByDisplay[did] {
                existingPanel.setFrame(screen.frame, display: true)
                existingView.frame = NSRect(origin: .zero, size: screen.frame.size)
                existingView.displayId = did
            } else {
                let p = NSPanel(
                    contentRect: screen.frame,
                    styleMask: [.borderless, .nonactivatingPanel],
                    backing: .buffered,
                    defer: false
                )
                p.level = .screenSaver
                p.backgroundColor = .clear
                p.isOpaque = false
                p.hasShadow = false
                p.ignoresMouseEvents = true
                p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]

                let v = OverlayCanvasView(frame: NSRect(origin: .zero, size: screen.frame.size))
                v.displayId = did
                p.contentView = v
                panelsByDisplay[did] = p
                viewsByDisplay[did] = v
            }
        }
        // Remove disconnected displays
        for (did, panel) in panelsByDisplay where !seenIds.contains(did) {
            panel.orderOut(nil)
            panelsByDisplay.removeValue(forKey: did)
            viewsByDisplay.removeValue(forKey: did)
        }
    }

    func ensureFrameClock() {
        if frameTimer != nil { return }
        frameTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.tickFrame()
            }
        }
    }

    private func easeOutBack(_ t: Double) -> CGFloat {
        let c1 = 1.45
        let c3 = c1 + 1.0
        let x = min(max(t, 0.0), 1.0) - 1.0
        return CGFloat(1.0 + c3 * pow(x, 3) + c1 * pow(x, 2))
    }

    func tickFrame() {
        let now = CACurrentMediaTime()

        // Interpolate Agent Cursor position with spring overshoot curve
        if let start = cursorStartPt, let target = cursorTargetPt {
            let elapsed = now - moveStartTime
            let rawT = moveDuration > 0 ? min(max(elapsed / moveDuration, 0.0), 1.0) : 1.0
            let eased = easeOutBack(rawT)
            let nx = start.x + (target.x - start.x) * eased
            let ny = start.y + (target.y - start.y) * eased
            let pt = NSPoint(x: nx, y: ny)
            cursorCurrentPt = pt
            trailSamples.append(CursorTrailSample(point: pt, timestamp: now))
        }

        // Prune trail samples older than 260ms
        trailSamples.removeAll { now - $0.timestamp > 0.26 }

        if rippleActive && (now - rippleStartTime) > 0.72 {
            rippleActive = false
        }

        for (did, view) in viewsByDisplay {
            if did == activeDisplayId {
                view.needsDisplay = true
            }
        }
    }

    func showStatus(
        mode: String,
        label: String,
        cursorLabel: String?,
        targetGlobalX: Double?,
        targetGlobalY: Double?,
        isClick: Bool,
        tooltip: String?,
        durationMs: Int
    ) {
        syncPanelsWithScreens()
        ensureFrameClock()

        let now = CACurrentMediaTime()
        self.activeMode = mode
        self.statusLabel = label
        if let cl = cursorLabel, !cl.isEmpty {
            self.cursorLabel = cl
        } else {
            self.cursorLabel = mode == "background" ? "Antigravity Background" : "Antigravity Agent"
        }
        self.tooltipText = tooltip

        // Resolve which physical screen contains (targetGlobalX, targetGlobalY)
        var resolvedScreen: NSScreen = NSScreen.main ?? NSScreen.screens.first!
        var localPt: NSPoint? = nil

        if let gx = targetGlobalX, let gy = targetGlobalY {
            let cocoaGlobal = quartzToCocoaGlobalPoint(gx: gx, gy: gy)
            for s in NSScreen.screens {
                if s.frame.contains(cocoaGlobal) {
                    resolvedScreen = s
                    break
                }
            }
            localPt = NSPoint(
                x: cocoaGlobal.x - resolvedScreen.frame.origin.x,
                y: cocoaGlobal.y - resolvedScreen.frame.origin.y
            )
        }

        let targetDid = screenDisplayID(resolvedScreen)
        if targetDid != activeDisplayId {
            // Switching monitors: reset cursor interpolation to target screen
            cursorCurrentPt = nil
            trailSamples.removeAll()
            activeDisplayId = targetDid
        }

        if let dest = localPt {
            if let curr = cursorCurrentPt {
                let dist = hypot(dest.x - curr.x, dest.y - curr.y)
                cursorStartPt = curr
                cursorTargetPt = dest
                moveStartTime = now
                moveDuration = min(max(Double(dist) / 1900.0, 0.14), 0.38)
            } else {
                // Spawn slightly offset so it glides in smoothly on first appearance
                let spawn = NSPoint(x: max(20, dest.x - 48), y: max(20, dest.y + 36))
                cursorCurrentPt = spawn
                cursorStartPt = spawn
                cursorTargetPt = dest
                moveStartTime = now
                moveDuration = 0.24
            }

            if isClick {
                ripplePoint = dest
                rippleStartTime = now
                rippleActive = true
            }
        }

        for (did, panel) in panelsByDisplay {
            if did == activeDisplayId {
                panel.orderFrontRegardless()
                viewsByDisplay[did]?.needsDisplay = true
            } else {
                panel.orderOut(nil)
            }
        }

        hideTimer?.invalidate()
        if durationMs > 0 {
            hideTimer = Timer.scheduledTimer(withTimeInterval: Double(durationMs) / 1000.0, repeats: false) { [weak self] _ in
                Task { @MainActor in
                    self?.hide()
                }
            }
        }
    }

    func hide() {
        hideTimer?.invalidate()
        hideTimer = nil
        frameTimer?.invalidate()
        frameTimer = nil
        for (_, panel) in panelsByDisplay {
            panel.orderOut(nil)
        }
    }
}

class OverlayCanvasView: NSView {
    var displayId: CGDirectDisplayID = CGMainDisplayID()

    // Aurora Neon Palette
    // Stops: Electric Blue (#1B6BF3), Deep Indigo (#3338E4), Aurora Magenta (#9B3DDF), Vivid Coral/Pink (#EA3E75), Solar Amber (#FA9434)
    private let auroraBlue    = NSColor(calibratedRed: 0.106, green: 0.420, blue: 0.953, alpha: 1.0) // #1B6BF3
    private let auroraIndigo  = NSColor(calibratedRed: 0.200, green: 0.220, blue: 0.894, alpha: 1.0) // #3338E4
    private let auroraViolet  = NSColor(calibratedRed: 0.608, green: 0.239, blue: 0.875, alpha: 1.0) // #9B3DDF
    private let auroraPink    = NSColor(calibratedRed: 0.918, green: 0.243, blue: 0.459, alpha: 1.0) // #EA3E75
    private let auroraAmber   = NSColor(calibratedRed: 0.980, green: 0.580, blue: 0.204, alpha: 1.0) // #FA9434
    private let auroraCyan    = NSColor(calibratedRed: 0.220, green: 0.740, blue: 0.970, alpha: 1.0) // #38BDF8

    /// Draws a 4-point aurora star indicator
    private func drawAuroraStar(ctx: CGContext, center: CGPoint, radius: CGFloat, rotation: CGFloat, color: NSColor) {
        ctx.saveGState()
        ctx.translateBy(x: center.x, y: center.y)
        ctx.rotate(by: rotation)
        let path = CGMutablePath()
        let rOuter = radius
        let rInner = radius * 0.22
        for i in 0..<8 {
            let angle = CGFloat(i) * (.pi / 4.0)
            let r = (i % 2 == 0) ? rOuter : rInner
            let pt = CGPoint(x: cos(angle) * r, y: sin(angle) * r)
            if i == 0 {
                path.move(to: pt)
            } else {
                path.addLine(to: pt)
            }
        }
        path.closeSubpath()
        ctx.setFillColor(color.cgColor)
        ctx.addPath(path)
        ctx.fillPath()
        ctx.restoreGState()
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let ctrl = OverlayController.shared
        guard displayId == ctrl.activeDisplayId,
              let ctx = NSGraphicsContext.current?.cgContext else { return }

        let now = CACurrentMediaTime()
        let pulse = CGFloat(0.5 + 0.5 * sin(now * 3.6))

        // 1. Screen-Edge Aurora Wave
        ctx.saveGState()
        let borderColors = [
            auroraBlue.withAlphaComponent(0.60 + 0.25 * pulse).cgColor,
            auroraViolet.withAlphaComponent(0.70).cgColor,
            auroraPink.withAlphaComponent(0.65 + 0.25 * (1.0 - pulse)).cgColor,
            auroraAmber.withAlphaComponent(0.55).cgColor,
            auroraCyan.withAlphaComponent(0.60).cgColor
        ] as CFArray
        if let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: borderColors, locations: [0.0, 0.25, 0.50, 0.75, 1.0]) {
            let borderPath = CGPath(rect: bounds.insetBy(dx: 3.5, dy: 3.5), transform: nil)
            ctx.addPath(borderPath)
            ctx.setLineWidth(5.0)
            ctx.replacePathWithStrokedPath()
            ctx.clip()
            let angle = CGFloat(now * 0.8)
            let cx = bounds.midX
            let cy = bounds.midY
            let r = hypot(bounds.width, bounds.height) * 0.55
            ctx.drawLinearGradient(
                grad,
                start: CGPoint(x: cx + cos(angle) * r, y: cy + sin(angle) * r),
                end: CGPoint(x: cx - cos(angle) * r, y: cy - sin(angle) * r),
                options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
            )
        }
        ctx.restoreGState()

        // 2. Floating Status Capsule Pill with Rotating Aurora Star
        let statusStr = ctrl.statusLabel as NSString
        let statusAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 12.0, weight: .semibold),
            .foregroundColor: NSColor(calibratedWhite: 0.98, alpha: 1.0)
        ]
        let textSize = statusStr.size(withAttributes: statusAttrs)
        let pillW = textSize.width + 50
        let pillH: CGFloat = 32
        let pillX = bounds.width - pillW - 22
        let pillY = bounds.height - pillH - 44
        let pillRect = NSRect(x: pillX, y: pillY, width: pillW, height: pillH)

        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -3), blur: 14, color: auroraViolet.withAlphaComponent(0.5).cgColor)
        let pillPath = NSBezierPath(roundedRect: pillRect, xRadius: 16, yRadius: 16)
        NSColor(calibratedRed: 0.07, green: 0.08, blue: 0.14, alpha: 0.94).setFill()
        pillPath.fill()
        ctx.restoreGState()

        auroraCyan.withAlphaComponent(0.85).setStroke()
        pillPath.lineWidth = 1.4
        pillPath.stroke()

        drawAuroraStar(
            ctx: ctx,
            center: CGPoint(x: pillX + 18, y: pillY + pillH / 2),
            radius: 8.0,
            rotation: CGFloat(now * 2.2),
            color: auroraCyan
        )
        statusStr.draw(at: NSPoint(x: pillX + 34, y: pillY + (pillH - textSize.height) / 2), withAttributes: statusAttrs)

        // 3. Stardust Particle Comet Trail behind Agent Pointer
        if ctrl.trailSamples.count > 1 {
            for i in 0..<(ctrl.trailSamples.count - 1) {
                let sample = ctrl.trailSamples[i]
                let age = now - sample.timestamp
                let alpha = CGFloat(max(0.0, 1.0 - age / 0.28))
                let r = 2.0 + 6.0 * alpha
                let trailColor = (i % 3 == 0 ? auroraCyan : (i % 3 == 1 ? auroraViolet : auroraPink)).withAlphaComponent(alpha * 0.52)
                let oval = NSBezierPath(ovalIn: NSRect(x: sample.point.x - r, y: sample.point.y - r, width: r * 2, height: r * 2))
                trailColor.setFill()
                oval.fill()
            }
        }

        // 4. Multi-Ring Aurora Shockwave Ripple + Sparkle Orbit on Click
        if ctrl.rippleActive, let rpt = ctrl.ripplePoint {
            let elapsed = CGFloat(now - ctrl.rippleStartTime)
            let p1 = min(max(elapsed / 0.52, 0.0), 1.0)
            let p2 = min(max((elapsed - 0.08) / 0.52, 0.0), 1.0)

            let rad1 = 6.0 + 48.0 * (1.0 - pow(1.0 - p1, 3))
            let alpha1 = (1.0 - p1) * 0.95
            let ring1 = NSBezierPath(ovalIn: NSRect(x: rpt.x - rad1, y: rpt.y - rad1, width: rad1 * 2, height: rad1 * 2))
            auroraCyan.withAlphaComponent(alpha1).setStroke()
            ring1.lineWidth = 2.8
            ring1.stroke()

            if elapsed > 0.08 {
                let rad2 = 4.0 + 36.0 * (1.0 - pow(1.0 - p2, 3))
                let alpha2 = (1.0 - p2) * 0.88
                let ring2 = NSBezierPath(ovalIn: NSRect(x: rpt.x - rad2, y: rpt.y - rad2, width: rad2 * 2, height: rad2 * 2))
                auroraViolet.withAlphaComponent(alpha2).setStroke()
                ring2.lineWidth = 2.0
                ring2.stroke()
            }

            // 4 rotating aurora sparkles expanding outwards
            for k in 0..<4 {
                let ang = CGFloat(k) * (.pi / 2.0) + p1 * 1.6
                let dist = 12.0 + 32.0 * p1
                let sx = rpt.x + cos(ang) * dist
                let sy = rpt.y + sin(ang) * dist
                drawAuroraStar(
                    ctx: ctx,
                    center: CGPoint(x: sx, y: sy),
                    radius: 5.0 * (1.0 - p1),
                    rotation: ang,
                    color: k % 2 == 0 ? auroraCyan : auroraAmber
                )
            }
        }

        // 5. Aurora Pointer with Luminous Halo and Agent Badge
        if let cpt = ctrl.cursorCurrentPt {
            ctx.saveGState()

            // Subtle luminous aura bloom around cursor tip
            let auraRadius: CGFloat = 18.0
            let auraOval = NSBezierPath(ovalIn: NSRect(x: cpt.x - auraRadius / 2, y: cpt.y - auraRadius / 2, width: auraRadius, height: auraRadius))
            auroraCyan.withAlphaComponent(0.28 + 0.15 * pulse).setFill()
            auraOval.fill()

            ctx.setShadow(offset: CGSize(width: 0, height: -2), blur: 12, color: auroraViolet.withAlphaComponent(0.85).cgColor)

            // Arrow cursor geometry
            let arrow = NSBezierPath()
            arrow.move(to: cpt) // tip
            arrow.line(to: NSPoint(x: cpt.x, y: cpt.y - 23))
            arrow.line(to: NSPoint(x: cpt.x + 6.2, y: cpt.y - 17.2))
            arrow.line(to: NSPoint(x: cpt.x + 10.8, y: cpt.y - 26.5))
            arrow.line(to: NSPoint(x: cpt.x + 14.2, y: cpt.y - 24.8))
            arrow.line(to: NSPoint(x: cpt.x + 9.5, y: cpt.y - 15.6))
            arrow.line(to: NSPoint(x: cpt.x + 17.2, y: cpt.y - 15.6))
            arrow.close()

            // Fill cursor arrow with Aurora gradient (#1B6BF3 -> #9B3DDF -> #EA3E75)
            if let arrowGrad = NSGradient(colors: [auroraCyan, auroraBlue, auroraViolet, auroraPink]) {
                arrowGrad.draw(in: arrow, angle: -45)
            } else {
                auroraBlue.setFill()
                arrow.fill()
            }
            NSColor.white.withAlphaComponent(0.96).setStroke()
            arrow.lineWidth = 1.5
            arrow.stroke()
            ctx.restoreGState()

            // Floating Context Pill with Aurora Star
            let badgeText = ctrl.cursorLabel as NSString
            let badgeAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11.0, weight: .bold),
                .foregroundColor: NSColor.white
            ]
            let bSize = badgeText.size(withAttributes: badgeAttrs)
            let bW = bSize.width + 28
            let bH: CGFloat = 22
            let bX = min(max(cpt.x + 16, 8), bounds.width - bW - 8)
            let bY = min(max(cpt.y - 34, 8), bounds.height - bH - 8)
            let bRect = NSRect(x: bX, y: bY, width: bW, height: bH)

            ctx.saveGState()
            ctx.setShadow(offset: CGSize(width: 0, height: -2), blur: 8, color: auroraViolet.withAlphaComponent(0.65).cgColor)
            let bPath = NSBezierPath(roundedRect: bRect, xRadius: 11, yRadius: 11)
            if let pillGrad = NSGradient(colors: [
                NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.24, alpha: 0.95),
                NSColor(calibratedRed: 0.16, green: 0.09, blue: 0.28, alpha: 0.95)
            ]) {
                pillGrad.draw(in: bPath, angle: 0)
            }
            ctx.restoreGState()

            auroraCyan.withAlphaComponent(0.85).setStroke()
            bPath.lineWidth = 1.2
            bPath.stroke()

            drawAuroraStar(
                ctx: ctx,
                center: CGPoint(x: bX + 11, y: bY + bH / 2),
                radius: 5.0,
                rotation: CGFloat(-now * 2.5),
                color: auroraCyan
            )
            badgeText.draw(at: NSPoint(x: bX + 20, y: bY + (bH - bSize.height) / 2), withAttributes: badgeAttrs)
        }

        // 6. Guided Walkthrough Callout (`teach_step`)
        if let tip = ctrl.tooltipText, !tip.isEmpty, let pt = ctrl.cursorCurrentPt ?? ctrl.ripplePoint {
            let tipStr = tip as NSString
            let tipAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 13, weight: .medium),
                .foregroundColor: NSColor.white
            ]
            let ts = tipStr.size(withAttributes: tipAttrs)
            let boxW = min(max(ts.width + 28, 160), 460)
            let boxH = ts.height + 20
            let boxX = min(max(pt.x - boxW / 2, 16), bounds.width - boxW - 16)
            let boxY = max(pt.y - boxH - 42, 16)
            let boxRect = NSRect(x: boxX, y: boxY, width: boxW, height: boxH)
            let boxPath = NSBezierPath(roundedRect: boxRect, xRadius: 12, yRadius: 12)
            NSColor(calibratedRed: 0.07, green: 0.08, blue: 0.14, alpha: 0.95).setFill()
            boxPath.fill()
            auroraViolet.withAlphaComponent(0.9).setStroke()
            boxPath.lineWidth = 1.6
            boxPath.stroke()
            tipStr.draw(at: NSPoint(x: boxX + 14, y: boxY + 10), withAttributes: tipAttrs)
        }
    }
}

// MARK: - In-Memory Fast Screenshot Capture + LumaDelta & 64-Bit dHash

var lastLumaGridByTarget: [String: [Float]] = [:]
var lastDHashByTarget: [String: UInt64] = [:]
let lumaLock = NSLock()

func computeLumaAndDHash(cgImage: CGImage, targetKey: String) -> (dHashHex: String, lumaDelta: Double, unchanged: Bool) {
    // Render into a tiny 9x8 grayscale buffer to compute both 64-bit horizontal dHash and 72-sample luma grid
    let w = 9
    let h = 8
    var pixels = [UInt8](repeating: 0, count: w * h)
    let colorSpace = CGColorSpaceCreateDeviceGray()
    if let ctx = CGContext(
        data: &pixels,
        width: w,
        height: h,
        bitsPerComponent: 8,
        bytesPerRow: w,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) {
        ctx.interpolationQuality = .low
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))
    }

    var dHash: UInt64 = 0
    var bitIdx: UInt64 = 0
    var lumaGrid = [Float](repeating: 0, count: w * h)
    for y in 0..<h {
        for x in 0..<w {
            let idx = y * w + x
            lumaGrid[idx] = Float(pixels[idx]) / 255.0
            if x < 8 {
                let left = pixels[idx]
                let right = pixels[idx + 1]
                if left > right {
                    dHash |= (1 << bitIdx)
                }
                bitIdx += 1
            }
        }
    }

    lumaLock.lock()
    let prevGrid = lastLumaGridByTarget[targetKey]
    let prevHash = lastDHashByTarget[targetKey]
    lastLumaGridByTarget[targetKey] = lumaGrid
    lastDHashByTarget[targetKey] = dHash
    lumaLock.unlock()

    var lumaDelta: Double = 1.0
    if let prev = prevGrid, prev.count == lumaGrid.count {
        var sumDiff: Float = 0
        for i in 0..<lumaGrid.count {
            sumDiff += abs(lumaGrid[i] - prev[i])
        }
        lumaDelta = Double(sumDiff) / Double(lumaGrid.count)
    }

    let hamming = prevHash != nil ? (dHash ^ prevHash!).nonzeroBitCount : 64
    let unchanged = (prevHash != nil) && (hamming <= 1) && (lumaDelta < 0.003)
    return (String(format: "%016llx", dHash), (lumaDelta * 10000).rounded() / 10000, unchanged)
}

func scaleAndEncodeJPEG(cgImage: CGImage, targetW: Int, targetH: Int, quality: Double, targetKey: String) -> [String: Any]? {
    let outW = max(1, targetW)
    let outH = max(1, targetH)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil,
        width: outW,
        height: outH,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else {
        return nil
    }
    ctx.interpolationQuality = .medium
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: outW, height: outH))
    guard let scaledCg = ctx.makeImage() else { return nil }

    let (dHashHex, lumaDelta, unchanged) = computeLumaAndDHash(cgImage: scaledCg, targetKey: targetKey)
    let rep = NSBitmapImageRep(cgImage: scaledCg)
    guard let jpegData = rep.representation(using: .jpeg, properties: [.compressionFactor: NSNumber(value: quality)]) else {
        return nil
    }
    return [
        "ok": true,
        "width": outW,
        "height": outH,
        "byteLength": jpegData.count,
        "dHash": dHashHex,
        "lumaDelta": lumaDelta,
        "unchanged": unchanged,
        "base64": jpegData.base64EncodedString()
    ]
}

typealias CGDisplayCreateImageFn = @convention(c) (CGDirectDisplayID) -> Unmanaged<CGImage>?
typealias CGWindowListCreateImageFn = @convention(c) (CGRect, UInt32, CGWindowID, UInt32) -> Unmanaged<CGImage>?

let fnCGDisplayCreateImage: CGDisplayCreateImageFn? = {
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGDisplayCreateImage") else { return nil }
    return unsafeBitCast(sym, to: CGDisplayCreateImageFn.self)
}()

let fnCGWindowListCreateImage: CGWindowListCreateImageFn? = {
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
    return unsafeBitCast(sym, to: CGWindowListCreateImageFn.self)
}()

func captureDisplayFast(params: [String: AnyCodable]) -> [String: Any] {
    let startMs = CACurrentMediaTime()
    let requestedDisplayId = params["displayId"]?.intValue
    var targetDisplayId = CGMainDisplayID()
    if let reqId = requestedDisplayId, reqId > 0 {
        targetDisplayId = CGDirectDisplayID(reqId)
    }
    let cgBounds = CGDisplayBounds(targetDisplayId)
    let dispW = Int(cgBounds.width)
    let dispH = Int(cgBounds.height)
    let targetW = params["width"]?.intValue ?? dispW
    let targetH = params["height"]?.intValue ?? dispH
    let quality = params["quality"]?.doubleValue ?? 0.76

    guard let rawCg = fnCGDisplayCreateImage?(targetDisplayId)?.takeRetainedValue() else {
        return ["ok": false, "error": "CGDisplayCreateImage failed for display \(targetDisplayId)"]
    }
    guard var encoded = scaleAndEncodeJPEG(
        cgImage: rawCg,
        targetW: targetW,
        targetH: targetH,
        quality: quality,
        targetKey: "display:\(targetDisplayId)"
    ) else {
        return ["ok": false, "error": "Failed to encode JPEG for display \(targetDisplayId)"]
    }
    encoded["displayId"] = Int(targetDisplayId)
    encoded["originX"] = Int(cgBounds.origin.x)
    encoded["originY"] = Int(cgBounds.origin.y)
    encoded["displayWidth"] = dispW
    encoded["displayHeight"] = dispH
    encoded["elapsedMs"] = Int(((CACurrentMediaTime() - startMs) * 1000.0).rounded())
    return encoded
}

func captureWindowFast(params: [String: AnyCodable]) -> [String: Any] {
    let startMs = CACurrentMediaTime()
    var targetWindowId: Int = 0
    if let wid = params["windowId"]?.intValue, wid > 0 {
        targetWindowId = wid
    } else if let appId = params["app"]?.stringValue, let app = findRunningApp(identifier: appId) {
        if let winList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            for win in winList {
                if let pid = win[kCGWindowOwnerPID as String] as? Int, pid == app.processIdentifier,
                   let wid = win[kCGWindowNumber as String] as? Int,
                   let bounds = win[kCGWindowBounds as String] as? [String: Any],
                   let h = bounds["Height"] as? Double, h >= 80 {
                    targetWindowId = wid
                    break
                }
            }
        }
        if targetWindowId == 0 {
            if let winList = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] {
                for win in winList {
                    if let pid = win[kCGWindowOwnerPID as String] as? Int, pid == app.processIdentifier,
                       let wid = win[kCGWindowNumber as String] as? Int,
                       let bounds = win[kCGWindowBounds as String] as? [String: Any],
                       let h = bounds["Height"] as? Double, h >= 80 {
                        targetWindowId = wid
                        break
                    }
                }
            }
        }
    }
    guard targetWindowId > 0 else {
        return ["ok": false, "error": "windowId or running app identifier with valid window is required"]
    }
    let quality = params["quality"]?.doubleValue ?? 0.76
    let listOption = CGWindowListOption.optionIncludingWindow.rawValue
    let imageOption = CGWindowImageOption([.boundsIgnoreFraming, .bestResolution]).rawValue
    guard let rawCg = fnCGWindowListCreateImage?(
        .null,
        listOption,
        CGWindowID(targetWindowId),
        imageOption
    )?.takeRetainedValue(), rawCg.width > 1 && rawCg.height > 1 else {
        return ["ok": false, "error": "CGWindowListCreateImage returned empty image for window \(targetWindowId)"]
    }
    let targetW = params["width"]?.intValue ?? rawCg.width
    let targetH = params["height"]?.intValue ?? rawCg.height
    guard var encoded = scaleAndEncodeJPEG(
        cgImage: rawCg,
        targetW: targetW,
        targetH: targetH,
        quality: quality,
        targetKey: "window:\(targetWindowId)"
    ) else {
        return ["ok": false, "error": "Failed to encode JPEG for window \(targetWindowId)"]
    }
    encoded["windowId"] = targetWindowId
    encoded["elapsedMs"] = Int(((CACurrentMediaTime() - startMs) * 1000.0).rounded())
    return encoded
}

// MARK: - Standalone App, Window, & CGEvent Input Helpers

func listRunningAppsInfo() -> [String: Any] {
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var apps: [[String: Any]] = []
    for rApp in NSWorkspace.shared.runningApplications {
        guard rApp.activationPolicy == .regular || rApp.activationPolicy == .accessory,
              let bid = rApp.bundleIdentifier, !bid.isEmpty else { continue }
        apps.append([
            "bundleId": bid,
            "displayName": rApp.localizedName ?? bid,
            "pid": Int(rApp.processIdentifier),
            "isRunning": true,
            "isActive": rApp.processIdentifier == frontPid
        ])
    }
    return ["ok": true, "apps": apps]
}

func listWindowsForApp(params: [String: AnyCodable]) -> [String: Any] {
    let appFilter = params["app"]?.stringValue
    var targetPids: Set<pid_t>? = nil
    if let appId = appFilter, !appId.isEmpty {
        let matched = NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier?.lowercased() == appId.lowercased() ||
            $0.localizedName?.lowercased() == appId.lowercased()
        }
        if matched.isEmpty, let fallback = findRunningApp(identifier: appId) {
            targetPids = [fallback.processIdentifier]
        } else {
            targetPids = Set(matched.map { $0.processIdentifier })
        }
    }

    guard let rawList = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return ["ok": true, "windows": []]
    }
    var out: [[String: Any]] = []
    for win in rawList {
        let layer = (win[kCGWindowLayer as String] as? Int) ?? 0
        guard layer == 0 else { continue }
        let ownerPid = pid_t((win[kCGWindowOwnerPID as String] as? Int) ?? 0)
        if let pids = targetPids, !pids.contains(ownerPid) { continue }
        guard let wid = win[kCGWindowNumber as String] as? Int,
              let boundsDict = win[kCGWindowBounds as String] as? [String: Any] else { continue }
        let x = (boundsDict["X"] as? Double) ?? 0
        let y = (boundsDict["Y"] as? Double) ?? 0
        let w = (boundsDict["Width"] as? Double) ?? 0
        let h = (boundsDict["Height"] as? Double) ?? 0
        if w < 10 || h < 10 { continue }
        let isOnscreen = (win[kCGWindowIsOnscreen as String] as? Bool) ?? false
        out.append([
            "windowId": wid,
            "pid": Int(ownerPid),
            "title": (win[kCGWindowName as String] as? String) ?? "",
            "ownerName": (win[kCGWindowOwnerName as String] as? String) ?? "",
            "isMain": isOnscreen,
            "isMinimized": false,
            "isOffSpace": !isOnscreen,
            "bounds": ["x": Int(x), "y": Int(y), "w": Int(w), "h": Int(h)]
        ])
    }
    return ["ok": true, "windows": out]
}

func currentMouseLocationQuartz() -> [String: Any] {
    let pt = NSEvent.mouseLocation
    let h0 = primaryScreenHeight()
    return ["ok": true, "x": Int(pt.x.rounded()), "y": Int((h0 - pt.y).rounded())]
}

func macVirtualKeyCode(for name: String) -> (CGKeyCode?, CGEventFlags) {
    switch name.lowercased() {
    case "return", "enter": return (36, [])
    case "tab": return (48, [])
    case "space": return (49, [])
    case "delete", "backspace": return (51, [])
    case "forwarddelete": return (117, [])
    case "escape", "esc": return (53, [])
    case "command", "cmd": return (55, .maskCommand)
    case "shift": return (56, .maskShift)
    case "alt", "option": return (58, .maskAlternate)
    case "control", "ctrl": return (59, .maskControl)
    case "fn": return (63, .maskSecondaryFn)
    case "left": return (123, [])
    case "right": return (124, [])
    case "down": return (125, [])
    case "up": return (126, [])
    case "home": return (115, [])
    case "end": return (119, [])
    case "pageup": return (116, [])
    case "pagedown": return (121, [])
    case "a": return (0, []); case "s": return (1, []); case "d": return (2, []); case "f": return (3, [])
    case "h": return (4, []); case "g": return (5, []); case "z": return (6, []); case "x": return (7, [])
    case "c": return (8, []); case "v": return (9, []); case "b": return (11, []); case "q": return (12, [])
    case "w": return (13, []); case "e": return (14, []); case "r": return (15, []); case "y": return (16, [])
    case "t": return (17, []); case "1": return (18, []); case "2": return (19, []); case "3": return (20, [])
    case "4": return (21, []); case "6": return (22, []); case "5": return (23, []); case "=": return (24, [])
    case "9": return (25, []); case "7": return (26, []); case "-": return (27, []); case "8": return (28, [])
    case "0": return (29, []); case "]": return (30, []); case "o": return (31, []); case "u": return (32, [])
    case "[": return (33, []); case "i": return (34, []); case "p": return (35, []); case "l": return (37, [])
    case "j": return (38, []); case "'": return (39, []); case "k": return (40, []); case ";": return (41, [])
    case "\\": return (42, []); case ",": return (43, []); case "/": return (44, []); case "n": return (45, [])
    case "m": return (46, []); case ".": return (47, []); case "`": return (50, [])
    case "f1": return (122, []); case "f2": return (120, []); case "f3": return (99, []); case "f4": return (118, [])
    case "f5": return (96, []); case "f6": return (97, []); case "f7": return (98, []); case "f8": return (100, [])
    case "f9": return (101, []); case "f10": return (109, []); case "f11": return (103, []); case "f12": return (111, [])
    default: return (nil, [])
    }
}

func performCgEventInput(params: [String: AnyCodable]) -> [String: Any] {
    let op = params["op"]?.stringValue ?? ""
    let src = CGEventSource(stateID: .hidSystemState)
    let curPt = CGPoint(x: params["x"]?.doubleValue ?? Double(NSEvent.mouseLocation.x),
                        y: params["y"]?.doubleValue ?? Double(primaryScreenHeight() - NSEvent.mouseLocation.y))

    switch op {
    case "move":
        CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: curPt, mouseButton: .left)?.post(tap: .cghidEventTap)
        return ["ok": true]

    case "mouseDown", "mouseUp", "click":
        let btnStr = params["button"]?.stringValue ?? "left"
        let button: CGMouseButton = btnStr == "right" ? .right : (btnStr == "middle" ? .center : .left)
        let downType: CGEventType = button == .right ? .rightMouseDown : (button == .center ? .otherMouseDown : .leftMouseDown)
        let upType: CGEventType = button == .right ? .rightMouseUp : (button == .center ? .otherMouseUp : .leftMouseUp)
        let count = max(1, params["count"]?.intValue ?? 1)
        var flags: CGEventFlags = []
        if let modArr = params["modifiers"]?.value as? [Any] {
            for m in modArr {
                if let s = m as? String { flags.insert(macVirtualKeyCode(for: s).1) }
            }
        }
        if op == "mouseDown" {
            let ev = CGEvent(mouseEventSource: src, mouseType: downType, mouseCursorPosition: curPt, mouseButton: button)
            ev?.flags = flags
            ev?.post(tap: .cghidEventTap)
            return ["ok": true]
        }
        if op == "mouseUp" {
            let ev = CGEvent(mouseEventSource: src, mouseType: upType, mouseCursorPosition: curPt, mouseButton: button)
            ev?.flags = flags
            ev?.post(tap: .cghidEventTap)
            return ["ok": true]
        }
        for c in 1...count {
            let down = CGEvent(mouseEventSource: src, mouseType: downType, mouseCursorPosition: curPt, mouseButton: button)
            let up = CGEvent(mouseEventSource: src, mouseType: upType, mouseCursorPosition: curPt, mouseButton: button)
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(c))
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(c))
            down?.flags = flags
            up?.flags = flags
            down?.post(tap: .cghidEventTap)
            up?.post(tap: .cghidEventTap)
        }
        return ["ok": true]

    case "scroll":
        let dx = Int32(params["dx"]?.intValue ?? 0)
        let dy = Int32(params["dy"]?.intValue ?? 0)
        if let ev = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
            ev.post(tap: .cghidEventTap)
        }
        return ["ok": true]

    case "typeText":
        let text = params["text"]?.stringValue ?? ""
        let utf16 = Array(text.utf16)
        if !utf16.isEmpty {
            let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
            let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
            down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            down?.post(tap: .cghidEventTap)
            up?.post(tap: .cghidEventTap)
        }
        return ["ok": true]

    case "keyPress", "keyDown", "keyUp":
        let keyName = params["key"]?.stringValue ?? ""
        let (codeOpt, _) = macVirtualKeyCode(for: keyName)
        guard let code = codeOpt else { return ["ok": false, "error": "Unsupported key: \(keyName)"] }
        if op != "keyUp" {
            CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
        }
        if op != "keyDown" {
            CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
        }
        return ["ok": true]

    case "keys":
        let arr = (params["keys"]?.value as? [Any])?.compactMap { $0 as? String } ?? []
        var flags: CGEventFlags = []
        var nonModCodes: [CGKeyCode] = []
        for k in arr {
            let (codeOpt, flag) = macVirtualKeyCode(for: k)
            if !flag.isEmpty {
                flags.insert(flag)
            } else if let code = codeOpt {
                nonModCodes.append(code)
            }
        }
        for code in nonModCodes {
            let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
            let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
            down?.flags = flags
            up?.flags = flags
            down?.post(tap: .cghidEventTap)
            up?.post(tap: .cghidEventTap)
        }
        return ["ok": true]

    default:
        return ["ok": false, "error": "Unknown cgEventInput op: \(op)"]
    }
}

func appUnderScreenPoint(params: [String: AnyCodable]) -> [String: Any] {
    guard let x = params["x"]?.doubleValue, let y = params["y"]?.doubleValue else {
        return ["ok": false, "error": "x and y are required"]
    }
    guard let rawList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return ["ok": true]
    }
    let pt = CGPoint(x: x, y: y)
    for win in rawList {
        let layer = (win[kCGWindowLayer as String] as? Int) ?? 0
        guard layer == 0,
              let boundsDict = win[kCGWindowBounds as String] as? [String: Any],
              let bx = boundsDict["X"] as? Double,
              let by = boundsDict["Y"] as? Double,
              let bw = boundsDict["Width"] as? Double,
              let bh = boundsDict["Height"] as? Double else { continue }
        let rect = CGRect(x: bx, y: by, width: bw, height: bh)
        if rect.contains(pt) {
            let pid = pid_t((win[kCGWindowOwnerPID as String] as? Int) ?? 0)
            let rApp = NSRunningApplication(processIdentifier: pid)
            return [
                "ok": true,
                "pid": Int(pid),
                "bundleId": rApp?.bundleIdentifier ?? "",
                "displayName": rApp?.localizedName ?? (win[kCGWindowOwnerName as String] as? String ?? "")
            ]
        }
    }
    return ["ok": true]
}

func moveAppBehind(params: [String: AnyCodable]) -> [String: Any] {
    let targetBundle = params["bundleId"]?.stringValue ?? "com.google.antigravity"
    if let rApp = findRunningApp(identifier: targetBundle) {
        rApp.hide()
        return ["ok": true, "bundleId": rApp.bundleIdentifier ?? targetBundle]
    }
    return ["ok": false]
}

func axTitle(_ elem: AXUIElement) -> String {
    var val: AnyObject?
    if AXUIElementCopyAttributeValue(elem, kAXTitleAttribute as CFString, &val) == .success, let s = val as? String {
        return s
    }
    return ""
}

func axChildren(_ elem: AXUIElement) -> [AXUIElement] {
    var val: AnyObject?
    if AXUIElementCopyAttributeValue(elem, kAXChildrenAttribute as CFString, &val) == .success, let arr = val as? [AXUIElement] {
        return arr
    }
    return []
}

func performAppMenu(params: [String: AnyCodable]) -> [String: Any] {
    guard let appId = params["app"]?.stringValue, let rApp = findRunningApp(identifier: appId) else {
        return ["outcome": "unsupported", "reasonCode": "app_not_running"]
    }
    let appElem = AXUIElementCreateApplication(rApp.processIdentifier)
    var menuBarObj: AnyObject?
    guard AXUIElementCopyAttributeValue(appElem, kAXMenuBarAttribute as CFString, &menuBarObj) == .success,
          let menuBar = menuBarObj else {
        return ["outcome": "unsupported", "reasonCode": "menu_bar_unavailable"]
    }
    let menuBarElem = menuBar as! AXUIElement
    let mode = params["mode"]?.stringValue ?? "list"
    let path = (params["path"]?.value as? [Any])?.compactMap { $0 as? String } ?? []

    if mode == "list" {
        var topItems: [[String: Any]] = []
        for item in axChildren(menuBarElem) {
            let title = axTitle(item)
            if title.isEmpty || title == "Apple" { continue }
            var subTitles: [String] = []
            if let subMenu = axChildren(item).first {
                for sub in axChildren(subMenu) {
                    let st = axTitle(sub)
                    if !st.isEmpty { subTitles.append(st) }
                }
            }
            if path.isEmpty || title.lowercased() == path[0].lowercased() {
                topItems.append(["menu": title, "items": subTitles])
            }
        }
        return ["outcome": "ok", "menus": topItems]
    }

    guard !path.isEmpty else {
        return ["outcome": "unsupported", "reasonCode": "empty_menu_path"]
    }

    var currentContainer: AXUIElement = menuBarElem
    for (idx, segment) in path.enumerated() {
        let children = axChildren(currentContainer)
        var matched: AXUIElement? = children.first { axTitle($0).lowercased() == segment.lowercased() }
        if matched == nil && children.count == 1 {
            matched = axChildren(children[0]).first { axTitle($0).lowercased() == segment.lowercased() }
        }
        guard let hit = matched else {
            return ["outcome": "unsupported", "reasonCode": "menu_item_not_found", "segment": segment]
        }
        if idx == path.count - 1 {
            let err = AXUIElementPerformAction(hit, kAXPressAction as CFString)
            return err == .success
                ? ["outcome": "ok", "path": path]
                : ["outcome": "unsupported", "reasonCode": "menu_press_failed", "axError": err.rawValue]
        }
        let sub = axChildren(hit).first ?? hit
        currentContainer = sub
    }
    return ["outcome": "unsupported", "reasonCode": "menu_item_not_found"]
}

// MARK: - Main Stdio JSON-RPC Loop

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

func writeResponse(id: Int?, result: [String: Any]) {
    var payload: [String: Any] = ["jsonrpc": "2.0", "result": result]
    if let id = id { payload["id"] = id }
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let str = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((str + "\n").data(using: .utf8)!)
    }
}

DispatchQueue.global(qos: .userInteractive).async {
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        guard let data = trimmed.data(using: .utf8),
              let req = try? JSONDecoder().decode(RPCRequest.self, from: data) else {
            continue
        }
        let params = req.params ?? [:]
        switch req.method {
        case "ping":
            writeResponse(id: req.id, result: ["ok": true, "version": "2.2.0"])
        case "listDisplays":
            let res = listPhysicalDisplays()
            writeResponse(id: req.id, result: res)
        case "listApps":
            let res = listRunningAppsInfo()
            writeResponse(id: req.id, result: res)
        case "listWindows":
            let res = listWindowsForApp(params: params)
            writeResponse(id: req.id, result: res)
        case "mouseLocation":
            let res = currentMouseLocationQuartz()
            writeResponse(id: req.id, result: res)
        case "cgEventInput":
            let res = performCgEventInput(params: params)
            writeResponse(id: req.id, result: res)
        case "appUnderPoint":
            let res = appUnderScreenPoint(params: params)
            writeResponse(id: req.id, result: res)
        case "moveAppBehind":
            let res = moveAppBehind(params: params)
            writeResponse(id: req.id, result: res)
        case "appMenu":
            let res = performAppMenu(params: params)
            writeResponse(id: req.id, result: res)
        case "captureDisplayFast":
            let res = captureDisplayFast(params: params)
            writeResponse(id: req.id, result: res)
        case "captureWindowFast":
            let res = captureWindowFast(params: params)
            writeResponse(id: req.id, result: res)
        case "waitForSettle":
            if let appId = params["app"]?.stringValue, let rApp = findRunningApp(identifier: appId) {
                ensureAXObserver(for: rApp.processIdentifier)
                let maxW = params["maxWaitMs"]?.intValue ?? 90
                let quietW = params["quietWindowMs"]?.intValue ?? 28
                let ms = waitForAdaptiveSettle(pid: rApp.processIdentifier, maxWaitMs: maxW, quietWindowMs: quietW)
                writeResponse(id: req.id, result: ["ok": true, "settledMs": ms])
            } else {
                writeResponse(id: req.id, result: ["ok": true, "settledMs": 0])
            }
        case "walkAxTree":
            let res = walkWindowAxTree(params: params)
            writeResponse(id: req.id, result: res)
        case "clickElement":
            let res = performClickElement(params: params)
            if let appId = params["app"]?.stringValue, let rApp = findRunningApp(identifier: appId) {
                bumpAxMutation(pid: rApp.processIdentifier)
            }
            writeResponse(id: req.id, result: res)
        case "selectText":
            let res = performSelectText(params: params)
            if let appId = params["app"]?.stringValue, let rApp = findRunningApp(identifier: appId) {
                bumpAxMutation(pid: rApp.processIdentifier)
            }
            writeResponse(id: req.id, result: res)
        case "setValue":
            let res = performSetValue(params: params)
            if let appId = params["app"]?.stringValue, let rApp = findRunningApp(identifier: appId) {
                bumpAxMutation(pid: rApp.processIdentifier)
            }
            writeResponse(id: req.id, result: res)
        case "performSecondaryAction":
            let res = performSecondaryAction(params: params)
            if let appId = params["app"]?.stringValue, let rApp = findRunningApp(identifier: appId) {
                bumpAxMutation(pid: rApp.processIdentifier)
            }
            writeResponse(id: req.id, result: res)
        case "moveWindowToDisplay":
            let res = moveWindowToDisplayAndDesktopSpace(params: params)
            if let appId = params["app"]?.stringValue, let rApp = findRunningApp(identifier: appId) {
                bumpAxMutation(pid: rApp.processIdentifier)
            }
            writeResponse(id: req.id, result: res)
        case "setRichClipboard":
            let text = params["text"]?.stringValue ?? ""
            let format = params["format"]?.stringValue ?? "text"
            let res = setRichClipboard(text: text, format: format)
            writeResponse(id: req.id, result: res)
        case "restoreClipboard":
            restoreClipboard()
            writeResponse(id: req.id, result: ["ok": true])
        case "showOverlay":
            let mode = params["mode"]?.stringValue ?? "display"
            let label = params["label"]?.stringValue ?? "Antigravity Agent · Esc to stop"
            let cursorLabel = params["cursorLabel"]?.stringValue
            let rx = params["x"]?.doubleValue
            let ry = params["y"]?.doubleValue
            let isClick = params["isClick"]?.boolValue ?? (rx != nil && ry != nil)
            let tip = params["tooltip"]?.stringValue
            let dur = params["durationMs"]?.intValue ?? 3500
            DispatchQueue.main.async {
                OverlayController.shared.showStatus(
                    mode: mode,
                    label: label,
                    cursorLabel: cursorLabel,
                    targetGlobalX: rx,
                    targetGlobalY: ry,
                    isClick: isClick,
                    tooltip: tip,
                    durationMs: dur
                )
            }
            writeResponse(id: req.id, result: ["ok": true])
        case "hideOverlay":
            DispatchQueue.main.async {
                OverlayController.shared.hide()
            }
            writeResponse(id: req.id, result: ["ok": true])
        default:
            writeResponse(id: req.id, result: ["ok": false, "error": "Unknown method: \(req.method)"])
        }
    }
    exit(0)
}

app.run()
