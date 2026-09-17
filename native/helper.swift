import Cocoa
import CoreGraphics
import Foundation

struct WindowBounds: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct WindowInfo: Codable {
    let id: Int
    let owner: String
    let title: String
    let bounds: WindowBounds
}

func listAllWindows() -> [WindowInfo] {
    guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    
    var results: [WindowInfo] = []
    for win in windowList {
        let owner = win[kCGWindowOwnerName as String] as? String ?? ""
        let title = win[kCGWindowName as String] as? String ?? ""
        let id = win[kCGWindowNumber as String] as? Int ?? 0
        let layer = win[kCGWindowLayer as String] as? Int ?? 0
        guard let boundsDict = win[kCGWindowBounds as String] as? [String: Any],
              let x = boundsDict["X"] as? Double,
              let y = boundsDict["Y"] as? Double,
              let width = boundsDict["Width"] as? Double,
              let height = boundsDict["Height"] as? Double else {
            continue
        }
        // Only include normal window layers with non-zero size
        if layer == 0 && width > 50 && height > 50 {
            results.append(WindowInfo(
                id: id,
                owner: owner,
                title: title,
                bounds: WindowBounds(x: x, y: y, width: width, height: height)
            ))
        }
    }
    return results
}

func findWindow(query: String) -> WindowInfo? {
    let lower = query.lowercased()
    let all = listAllWindows()
    // First try exact match on owner or title
    if let match = all.first(where: { $0.owner.lowercased() == lower || $0.title.lowercased() == lower }) {
        return match
    }
    // Then partial match
    return all.first(where: { $0.owner.lowercased().contains(lower) || $0.title.lowercased().contains(lower) })
}

func clickAt(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)
    guard let mouseDown = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let mouseUp = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        fputs("Failed to create mouse event\n", stderr)
        return
    }
    mouseDown.post(tap: .cghidEventTap)
    usleep(50_000) // 50ms hold
    mouseUp.post(tap: .cghidEventTap)
}

let args = CommandLine.arguments
if args.count < 2 {
    print("Usage: helper <command> [args...]")
    print("Commands:")
    print("  window [query]                   Find window matching query (default: 'iPhone Mirroring')")
    print("  list-windows                     List all top-level application windows")
    print("  click <x> <y>                    Click at screen coordinates")
    print("  tap-sequence <x1> <y1> <x2> <y2> [delayMs] Click first then second location")
    exit(1)
}

let cmd = args[1]
let encoder = JSONEncoder()
encoder.outputFormatting = .prettyPrinted

switch cmd {
case "window":
    let query = args.count > 2 ? args[2] : "iPhone Mirroring"
    if let win = findWindow(query: query) {
        if let data = try? encoder.encode(win), let json = String(data: data, encoding: .utf8) {
            print(json)
        }
    } else {
        print("{\"error\": \"Window not found matching '\(query)'\"}")
        exit(1)
    }

case "list-windows":
    let wins = listAllWindows()
    if let data = try? encoder.encode(wins), let json = String(data: data, encoding: .utf8) {
        print(json)
    }

case "click":
    guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
        fputs("Invalid coordinates\n", stderr)
        exit(1)
    }
    clickAt(x: x, y: y)
    print("{\"success\": true, \"x\": \(x), \"y\": \(y)}")

case "tap-sequence":
    guard args.count >= 6,
          let x1 = Double(args[2]), let y1 = Double(args[3]),
          let x2 = Double(args[4]), let y2 = Double(args[5]) else {
        fputs("Invalid sequence coordinates\n", stderr)
        exit(1)
    }
    let delayMs = args.count > 6 ? (UInt32(args[6]) ?? 150) : 150
    clickAt(x: x1, y: y1)
    usleep(delayMs * 1000)
    clickAt(x: x2, y: y2)
    print("{\"success\": true}")

default:
    fputs("Unknown command: \(cmd)\n", stderr)
    exit(1)
}
