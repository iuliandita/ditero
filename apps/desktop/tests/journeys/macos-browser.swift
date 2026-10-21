import AppKit
import ApplicationServices
import Foundation

func attribute(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (error, value)
}
func text(_ element: AXUIElement, _ name: String) -> String {
    let (error, value) = attribute(element, name)
    return error == .success ? (value as? String ?? "") : "AXError(\(error.rawValue))"
}
print("Accessibility trusted: \(AXIsProcessTrusted())")
var diagnostic = ""
for _ in 0..<40 {
    for process in NSWorkspace.shared.runningApplications.filter({ $0.localizedName == "CoreServicesUIAgent" || $0.bundleIdentifier?.lowercased() == "com.apple.coreservices.uiagent" }) {
        print("Inspecting \(process.localizedName ?? "unknown") (\(process.bundleIdentifier ?? "unknown"))")
        let app = AXUIElementCreateApplication(process.processIdentifier)
        let (error, value) = attribute(app, kAXWindowsAttribute)
        guard error == .success, let windows = value as? [AXUIElement] else {
            diagnostic = "Windows: \(error.rawValue)"
            continue
        }
        for window in windows {
            var elements = [window]
            var index = 0
            var open: AXUIElement?
            var chrome = false
            var snapshot = ""
            while index < elements.count && index < 1000 {
                let element = elements[index]
                index += 1
                let role = text(element, kAXRoleAttribute)
                let title = text(element, kAXTitleAttribute)
                let description = text(element, kAXDescriptionAttribute)
                let value = text(element, kAXValueAttribute)
                snapshot += "\(role) | \(title) | \(description) | \(value)\n"
                if [title, description, value].contains(where: { $0.contains("Google Chrome") }) { chrome = true }
                if role == kAXButtonRole && (title == "Open" || description == "Open") { open = element }
                if let children = attribute(element, kAXChildrenAttribute).1 as? [AXUIElement] { elements += children }
            }
            diagnostic = snapshot
            if chrome, let button = open {
                process.activate(options: [.activateIgnoringOtherApps])
                let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
                print(snapshot)
                print("Chrome Open press: \(result.rawValue)")
                exit(result == .success ? 0 : 1)
            }
        }
    }
    Thread.sleep(forTimeInterval: 0.25)
}
print(diagnostic)
print("No matching Chrome confirmation")
