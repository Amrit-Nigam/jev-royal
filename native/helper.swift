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

struct TowerNumber: Codable {
    let value: Double
    let x: Double
    let y: Double
}

struct OcrAnalysisResult: Codable {
    let rawTexts: [TextObservation]
    let detectedElixir: Double?
    let detectedPhase: String?
    let towerNumbers: [TowerNumber]
}

struct MotionCell: Codable {
    let side: String // "own" or "opponent"
    let lane: String // "left", "center", "right"
    let intensity: Double // 0-255 average pixel delta
}

struct MotionResult: Codable {
    let cells: [MotionCell]
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

func activateIPhoneMirroring() {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.ScreenContinuity")
    if let app = apps.first, !app.isActive {
        app.activate()
        usleep(250_000) // give focus time to settle before sending input
    }
}

func clickAt(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)

    // iPhone Mirroring only registers taps that look like real touch input:
    // the system cursor must actually be at the target point (not just the
    // event's embedded coordinate), and a bare down/up with no movement in
    // between is frequently swallowed. Warp the cursor, nudge it, then send
    // the click through the real HID event source.
    CGWarpMouseCursorPosition(point)
    usleep(20_000)

    let source = CGEventSource(stateID: .hidSystemState)

    guard let moved = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
          let mouseDown = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let nudge = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: CGPoint(x: point.x + 1, y: point.y), mouseButton: .left),
          let mouseUp = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        fputs("Failed to create mouse event\n", stderr)
        return
    }

    moved.post(tap: .cghidEventTap)
    usleep(20_000)
    mouseDown.post(tap: .cghidEventTap)
    usleep(30_000)
    nudge.post(tap: .cghidEventTap)
    usleep(30_000)
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
    var towerNumbers: [TowerNumber] = []
    
    for item in items {
        let upper = item.text.uppercased()
        
        // Match phase detection
        if upper.contains("VICTORY") || upper.contains("VICTOIRE") ||
           upper.contains("DEFEAT") || upper.contains("DÉFAITE") ||
           upper.contains("CROWNS") || upper.contains("MATCH OVER") {
            detectedPhase = "post-game"
        } else if (upper.contains("OVERTIME") || upper.contains("SUDDEN DEATH")) && detectedPhase != "post-game" {
            detectedPhase = "overtime"
        } else if (upper.contains("TIME LEFT") || upper.contains("2:") || upper.contains("1:") || upper.contains("0:")) && detectedPhase == nil {
            detectedPhase = "in-progress"
        } else if (upper.contains("EVENTS") || upper.contains("SHOP")) && item.y > 0.85 && detectedPhase == nil {
            detectedPhase = "menu"
        }
        
        // Elixir detection (bottom region y > 0.90, ignore 'Max: 10')
        if item.y > 0.90 && !upper.contains("MAX") {
            let cleaned = item.text.trimmingCharacters(in: CharacterSet.decimalDigits.inverted)
            if let val = Double(cleaned), val >= 0 && val <= 10 {
                detectedElixir = val
            }
        }
        
        // Tower numbers (typically 3 or 4 digits: 500 to 6000)
        let digitsOnly = item.text.trimmingCharacters(in: CharacterSet.decimalDigits.inverted)
        if let num = Double(digitsOnly), num >= 500 && num <= 6000 {
            towerNumbers.append(TowerNumber(value: num, x: item.x, y: item.y))
        }
    }
    
    // Default to in-progress if we found tower numbers or in-battle elements
    if detectedPhase == nil && (!towerNumbers.isEmpty || detectedElixir != nil) {
        detectedPhase = "in-progress"
    }
    
    return OcrAnalysisResult(
        rawTexts: items,
        detectedElixir: detectedElixir,
        detectedPhase: detectedPhase,
        towerNumbers: towerNumbers
    )
}

// Raw RGBA pixel buffer loader, used for frame-to-frame motion detection since
// OCR text cannot identify troop sprites (troops don't carry readable text).
func loadPixels(_ path: String) -> (width: Int, height: Int, data: [UInt8])? {
    guard let image = NSImage(contentsOfFile: path),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return nil
    }
    let width = cgImage.width
    let height = cgImage.height
    var data = [UInt8](repeating: 0, count: width * height * 4)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: &data,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return nil
    }
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    return (width, height, data)
}

/// Detects motion between two consecutive frames of the same window, bucketed
/// into a 3x2 lane/side grid over the battle arena band (excludes the top
/// status bar and bottom hand UI, which change every frame regardless of
/// troop movement). Reports intensity per cell rather than guessing troop
/// identity — Jev is told "something is happening here", not a fabricated name.
func detectMotion(prevPath: String, currPath: String) -> MotionResult {
    guard let prev = loadPixels(prevPath), let curr = loadPixels(currPath),
          prev.width == curr.width, prev.height == curr.height else {
        return MotionResult(cells: [])
    }

    let width = prev.width
    let height = prev.height
    let arenaTop = 0.15  // below opponent status bar
    let arenaBottom = 0.85 // above own hand cards
    let colBounds = [0.0, 0.38, 0.62, 1.0] // left / center / right
    let rowMid = 0.5 // own half vs opponent half

    var sums = [[Double]](repeating: [Double](repeating: 0, count: 3), count: 2)
    var counts = [[Int]](repeating: [Int](repeating: 0, count: 3), count: 2)

    let stride = 3 // sample every 3rd pixel per axis to keep this fast
    var y = 0
    while y < height {
        let yPercent = Double(y) / Double(height)
        if yPercent >= arenaTop && yPercent <= arenaBottom {
            let rowIdx = yPercent < rowMid ? 0 : 1 // 0 = opponent (top), 1 = own (bottom)
            var x = 0
            while x < width {
                let xPercent = Double(x) / Double(width)
                var colIdx = 1
                if xPercent < colBounds[1] { colIdx = 0 } else if xPercent >= colBounds[2] { colIdx = 2 }

                let idx = (y * width + x) * 4
                let dr = abs(Int(curr.data[idx]) - Int(prev.data[idx]))
                let dg = abs(Int(curr.data[idx + 1]) - Int(prev.data[idx + 1]))
                let db = abs(Int(curr.data[idx + 2]) - Int(prev.data[idx + 2]))
                sums[rowIdx][colIdx] += Double(dr + dg + db) / 3.0
                counts[rowIdx][colIdx] += 1

                x += stride
            }
        }
        y += stride
    }

    let sides = ["opponent", "own"]
    let lanes = ["left", "center", "right"]
    var cells: [MotionCell] = []
    let threshold = 14.0 // filters sensor/compression noise from real movement
    for r in 0..<2 {
        for c in 0..<3 {
            guard counts[r][c] > 0 else { continue }
            let avg = sums[r][c] / Double(counts[r][c])
            if avg > threshold {
                cells.append(MotionCell(side: sides[r], lane: lanes[c], intensity: avg))
            }
        }
    }
    return MotionResult(cells: cells)
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
    print("  motion <prevImagePath> <currImagePath>  Detect lane/side motion between two frames")
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
    activateIPhoneMirroring()
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
    activateIPhoneMirroring()
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

case "motion":
    guard args.count >= 4 else {
        fputs("Usage: helper motion <prevImagePath> <currImagePath>\n", stderr)
        exit(1)
    }
    let result = detectMotion(prevPath: args[2], currPath: args[3])
    if let data = try? encoder.encode(result), let json = String(data: data, encoding: .utf8) {
        print(json)
    }

default:
    fputs("Unknown command: \(cmd)\n", stderr)
    exit(1)
}
