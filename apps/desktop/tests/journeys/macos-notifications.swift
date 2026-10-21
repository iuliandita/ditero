import AppKit
import ApplicationServices
import Foundation

let mode = CommandLine.arguments[1]
let evidence = URL(fileURLWithPath: ProcessInfo.processInfo.environment["RUNNER_TEMP"]!)
    .appendingPathComponent("desktop-journeys/evidence")
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return result == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String {
    attribute(element, name) as? String ?? ""
}
let deadline = Date().addingTimeInterval(mode == "permission" ? 55 : 45)
var last = ""
while Date() < deadline {
    for app in NSWorkspace.shared.runningApplications.filter({
        $0.bundleIdentifier == "io.ditero.desktop" ||
        ["NotificationCenter", "UserNotificationCenter", "SystemUIServer"].contains($0.localizedName ?? "")
    }) {
        let application = AXUIElementCreateApplication(app.processIdentifier)
        var elements = [application]
        var index = 0
        var snapshot = "Application: \(app.bundleIdentifier ?? "")\n"
        var allow: AXUIElement?
        var popup: AXUIElement?
        var mentionsDitero = false
        while index < elements.count && index < 2000 {
            let element = elements[index]
            index += 1
            let role = text(element, kAXRoleAttribute)
            let title = text(element, kAXTitleAttribute)
            let description = text(element, kAXDescriptionAttribute)
            let value = text(element, kAXValueAttribute)
            let words = [title, description, value].joined(separator: " | ")
            snapshot += "\(role) | \(words)\n"
            if words.contains("Ditero") { mentionsDitero = true }
            if role == kAXButtonRole && (title == "Allow" || description == "Allow") { allow = element }
            if words.contains("Open Ditero to view your notification.") { popup = element }
            if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] { elements += children }
        }
        last += snapshot
        if mode == "permission", mentionsDitero, let button = allow {
            let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
            try snapshot.write(to: evidence.appendingPathComponent("notification-permission-ax.txt"), atomically: true, encoding: .utf8)
            print("Ditero notification consent press: \(result.rawValue)")
            exit(result == .success ? 0 : 1)
        }
        if (mode == "click" || mode == "show"), let element = popup {
            try snapshot.write(to: evidence.appendingPathComponent("notification-popup-ax.txt"), atomically: true, encoding: .utf8)
            let shot = Process()
            shot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            shot.arguments = ["-x", evidence.appendingPathComponent("notification-shown.png").path]
            try shot.run(); shot.waitUntilExit()
            if mode == "show" { print("Observed actual Ditero notification"); exit(0) }
            var target: AXUIElement? = element
            for _ in 0..<5 {
                guard let current = target else { break }
                if AXUIElementPerformAction(current, kAXPressAction as CFString) == .success {
                    print("Pressed actual Ditero notification")
                    exit(0)
                }
                target = attribute(current, kAXParentAttribute) as! AXUIElement?
            }
            // Some NotificationCenter text exposes no press action; click its measured bounds.
            if let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute) {
                var point = CGPoint.zero
                var extent = CGSize.zero
                if AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent), extent.width > 0, extent.height > 0 {
                    let location = CGPoint(x: point.x + extent.width / 2, y: point.y + extent.height / 2)
                    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: location, mouseButton: .left)?.post(tap: .cghidEventTap)
                    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: location, mouseButton: .left)?.post(tap: .cghidEventTap)
                    print("Clicked measured Ditero notification bounds")
                    exit(0)
                }
            }
            print("Notification found but no usable click target")
            exit(1)
        }
    }
    try last.write(to: evidence.appendingPathComponent("notification-\(mode)-last-ax.txt"), atomically: true, encoding: .utf8)
    last = ""
    Thread.sleep(forTimeInterval: 0.2)
}
print("No Ditero notification \(mode) target; AX trusted: \(AXIsProcessTrusted())")
exit(1)
