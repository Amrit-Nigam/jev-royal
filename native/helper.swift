import Cocoa
import CoreGraphics
import Foundation
import Vision

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

struct TextObservation: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OcrAnalysisResult: Codable {
    let rawTexts: [TextObservation]
    let detectedElixir: Double?
    let detectedPhase: String?
    let towerNumbers: [Double]
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
    if let match = all.first(where: { $0.owner.lowercased() == lower || $0.title.lowercased() == lower }) {
        return match
    }
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

func analyzeImageOCR(imagePath: String) -> OcrAnalysisResult {
    guard let image = NSImage(contentsOfFile: imagePath),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return OcrAnalysisResult(rawTexts: [], detectedElixir: nil, detectedPhase: nil, towerNumbers: [])
    }
    
    var items: [TextObservation] = []
    let request = VNRecognizeTextRequest { req, err in
        guard let obs = req.results as? [VNRecognizedTextObservation] else { return }
        for o in obs {
            guard let candidate = o.topCandidates(1).first else { continue }
            let b = o.boundingBox
            // Convert Vision coordinate (0=bottom) to standard UI (0=top, 1=bottom)
            let topDownY = 1.0 - (b.origin.y + b.size.height)
            items.append(TextObservation(
                text: candidate.string,
                confidence: candidate.confidence,
                x: Double(b.origin.x),
                y: Double(topDownY),
                width: Double(b.size.width),
                height: Double(b.size.height)
            ))
        }
    }
    request.recognitionLevel = .accurate
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try? handler.perform([request])
    
    // Parse heuristics
    var detectedPhase: String? = nil
    var detectedElixir: Double? = nil
    var towerNumbers: [Double] = []
    
    for item in items {
        let upper = item.text.uppercased()
        
        // Match phase detection
        if upper.contains("VICTORY") || upper.contains("VICTOIRE") ||
           upper.contains("DEFEAT") || upper.contains("DÉFAITE") ||
           upper.contains("CROWNS") || upper.contains("MATCH OVER") {
            detectedPhase = "post-game"
        } else if (upper.contains("OVERTIME") || upper.contains("SUDDEN DEATH")) && detectedPhase != "post-game" {
            detectedPhase = "overtime"
        } else if (upper.contains("BATTLE") || upper.contains("EVENTS") || upper.contains("SHOP")) && item.y > 0.85 {
            detectedPhase = "menu"
        }
        
        // Elixir detection (bottom 15% of screen, y > 0.85)
        if item.y > 0.85 {
            // Check if string is a number 0..10
            let cleaned = item.text.trimmingCharacters(in: CharacterSet.decimalDigits.inverted)
            if let val = Double(cleaned), val >= 0 && val <= 10 {
                detectedElixir = val
            }
        }
        
        // Tower numbers (typically 3 or 4 digits: 500 to 5000)
        let digitsOnly = item.text.trimmingCharacters(in: CharacterSet.decimalDigits.inverted)
        if let num = Double(digitsOnly), num >= 500 && num <= 6000 {
            towerNumbers.append(num)
        }
    }
    
    return OcrAnalysisResult(
        rawTexts: items,
        detectedElixir: detectedElixir,
        detectedPhase: detectedPhase,
        towerNumbers: towerNumbers
    )
}

let args = CommandLine.arguments
if args.count < 2 {
    print("Usage: helper <command> [args...]")
    print("Commands:")
    print("  window [query]                   Find window matching query (default: 'iPhone Mirroring')")
    print("  list-windows                     List all top-level application windows")
    print("  click <x> <y>                    Click at screen coordinates")
    print("  tap-sequence <x1> <y1> <x2> <y2> [delayMs] Click first then second location")
    print("  ocr <imagePath>                  Run Apple Vision OCR on image")
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

case "ocr":
    guard args.count >= 3 else {
        fputs("Usage: helper ocr <imagePath>\n", stderr)
        exit(1)
    }
    let result = analyzeImageOCR(imagePath: args[2])
    if let data = try? encoder.encode(result), let json = String(data: data, encoding: .utf8) {
        print(json)
    }

default:
    fputs("Unknown command: \(cmd)\n", stderr)
    exit(1)
}
