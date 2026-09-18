import Cocoa
import CoreGraphics
import Foundation
import Vision

// MARK: - Window model

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

// MARK: - Perception model

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

/// A single candidate identity for a card slot.
struct CardCandidate: Codable {
    let key: String
    let name: String
    let elixir: Int
    let type: String
    let score: Double
}

/// One recognized card slot. `score` is the normalized cross-correlation with
/// the best-matching reference art; `margin` is how far ahead of the runner-up
/// it is. Callers use both to decide whether to trust the identification.
///
/// `alternatives` carries the next-best candidates so the caller can apply
/// knowledge the matcher does not have — most importantly which eight cards are
/// actually in this deck, which resolves the desaturated "cannot afford"
/// rendering that otherwise pulls a match toward a visually similar card.
struct CardMatch: Codable {
    let slot: Int
    let key: String
    let name: String
    let elixir: Int
    let type: String
    let score: Double
    let margin: Double
    let alternatives: [CardCandidate]
}

/// A health bar found in the arena. Clash Royale draws enemy bars red and
/// friendly bars blue, which is the only cheap on-screen signal that says who
/// owns a unit. Tower bars are static and get filtered out downstream.
struct HealthBar: Codable {
    let owner: String // "opponent" (red) or "own" (blue)
    let x: Double
    let y: Double
    let width: Double
}

struct MotionCell: Codable {
    let x: Double
    let y: Double
    let intensity: Double
}

struct GameStateResult: Codable {
    let inBattle: Bool
    let elixir: Double?
    let doubleElixir: Bool
    let cards: [CardMatch]
    let nextCard: CardMatch?
    let healthBars: [HealthBar]
    let motion: [MotionCell]
    let towerNumbers: [TowerNumber]
    let detectedPhase: String?
    let timeRemainingSeconds: Int?
    let rawTexts: [TextObservation]
}

// MARK: - Screen geometry
//
// All values are fractions of the captured iPhone Mirroring window image, and
// were measured off real 604x1334 capture frames (see tools/ and the capture
// set). Using fractions keeps them valid if the mirroring window is resized.

enum Geometry {
    /// Horizontal centers of the four card slots in hand.
    static let cardSlotX: [Double] = [0.3204, 0.4983, 0.6763, 0.8542]
    /// Vertical band covering a card's inner art, above its elixir badge.
    static let cardArtTop = 0.8305
    static let cardArtBottom = 0.9050
    static let cardHalfWidth = 0.0745

    /// The "Next:" card preview in the bottom-left corner. It is a much smaller
    /// thumbnail than a hand slot, so matches against it are noisier and the
    /// caller should treat a low score as "unknown" rather than trust it.
    static let nextCardX = 0.0967
    static let nextCardTop = 0.9190
    static let nextCardBottom = 0.9540
    static let nextCardHalfWidth = 0.0200

    /// The player-info box in the top-left corner holds the opponent's name and
    /// trophy count. Numbers inside it are never tower hit points.
    static let playerInfoRight = 0.32
    static let playerInfoBottom = 0.20

    /// Rows sampled across the elixir bar. Several rows are sampled and the
    /// median taken so a single row of compression noise can't skew the value.
    static let elixirRows: [Double] = [0.9498, 0.9513, 0.9528, 0.9543]
    static let elixirScanLeft = 0.20
    static let elixirScanRight = 0.99

    /// Playable arena band: below the opponent's status bar, above the hand UI.
    static let arenaTop = 0.13
    static let arenaBottom = 0.84
    static let arenaLeft = 0.03
    static let arenaRight = 0.97
}

// MARK: - Card recognition index

struct IndexedCard: Codable {
    let key: String
    let name: String
    let elixir: Int
    let type: String
    let rarity: String
    let vector: [Double]
}

struct CardIndex: Codable {
    let gridSize: Int
    let cards: [IndexedCard]
}

/// Loads assets/card-index.json, built by tools/build_card_index.py from the
/// open-source RoyaleAPI card art and metadata. Cached for the process.
func loadCardIndex() -> CardIndex? {
    let override = ProcessInfo.processInfo.environment["CARD_INDEX_PATH"]
    let candidates = [
        override,
        FileManager.default.currentDirectoryPath + "/assets/card-index.json",
    ].compactMap { $0 }

    for path in candidates {
        guard let data = FileManager.default.contents(atPath: path) else { continue }
        if let index = try? JSONDecoder().decode(CardIndex.self, from: data) {
            return index
        }
    }
    return nil
}

// MARK: - Pixel access

struct Frame {
    let width: Int
    let height: Int
    let data: [UInt8]

    @inline(__always)
    func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let idx = (y * width + x) * 4
        return (Int(data[idx]), Int(data[idx + 1]), Int(data[idx + 2]))
    }

    @inline(__always)
    func luma(_ x: Int, _ y: Int) -> Double {
        let (r, g, b) = rgb(x, y)
        // Rec. 601 luma, matching how PIL's "L" conversion weights channels so
        // the reference vectors built in Python stay comparable.
        return 0.299 * Double(r) + 0.587 * Double(g) + 0.114 * Double(b)
    }
}

func loadFrame(_ path: String) -> Frame? {
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
    return Frame(width: width, height: height, data: data)
}

// MARK: - Elixir

/// Reads the elixir bar by measuring how far the magenta fill extends across
/// the bar's full track. This yields a fractional value (e.g. 7.15), which the
/// digit OCR could never provide, and fractional elixir is what makes real
/// elixir management possible. Returns nil when no bar is on screen, which is
/// also the most reliable "are we actually in a battle" signal available.
func readElixir(_ frame: Frame) -> Double? {
    @inline(__always) func isFill(_ p: (Int, Int, Int)) -> Bool {
        let (r, g, b) = p
        return r > 130 && b > 140 && g < 115 && (Double(r + b) / 2.0 - Double(g)) > 55
    }
    @inline(__always) func isEmpty(_ p: (Int, Int, Int)) -> Bool {
        let (r, g, b) = p
        return b > 90 && (b - r) > 50 && g < 100 && r < 110
    }

    let xStart = Int(Geometry.elixirScanLeft * Double(frame.width))
    let xEnd = Int(Geometry.elixirScanRight * Double(frame.width))

    var samples: [Double] = []
    for rowFraction in Geometry.elixirRows {
        let y = Int(rowFraction * Double(frame.height))
        guard y >= 0 && y < frame.height else { continue }

        var left = -1
        var right = -1
        var lastFill = -1
        for x in xStart..<xEnd {
            let p = frame.rgb(x, y)
            if isFill(p) || isEmpty(p) {
                if left < 0 { left = x }
                right = x
                if isFill(p) { lastFill = x }
            }
        }
        // A real bar spans most of the HUD width; anything shorter is noise or
        // an unrelated magenta UI element.
        guard left >= 0, right - left > frame.width / 4 else { continue }
        let value = lastFill < 0 ? 0.0 : Double(lastFill - left) / Double(right - left) * 10.0
        samples.append(min(10.0, max(0.0, value)))
    }

    guard !samples.isEmpty else { return nil }
    samples.sort()
    return samples[samples.count / 2]
}

// MARK: - Card matching

/// Builds the same feature vector the Python index builder produces: grayscale,
/// downsampled to gridSize x gridSize, then z-normalized. Z-normalization is
/// what makes matching survive the desaturated rendering Clash Royale uses for
/// cards you cannot currently afford.
func featureVector(_ frame: Frame, x0: Int, y0: Int, x1: Int, y1: Int, gridSize: Int) -> [Double]? {
    guard x1 > x0, y1 > y0 else { return nil }
    let cellW = Double(x1 - x0) / Double(gridSize)
    let cellH = Double(y1 - y0) / Double(gridSize)

    var values = [Double](repeating: 0, count: gridSize * gridSize)
    for gy in 0..<gridSize {
        for gx in 0..<gridSize {
            // Average the source pixels covered by this grid cell, which
            // approximates the bilinear downsample used when indexing.
            let sx0 = x0 + Int(Double(gx) * cellW)
            let sy0 = y0 + Int(Double(gy) * cellH)
            let sx1 = max(sx0 + 1, x0 + Int(Double(gx + 1) * cellW))
            let sy1 = max(sy0 + 1, y0 + Int(Double(gy + 1) * cellH))

            var sum = 0.0
            var count = 0
            var sy = sy0
            while sy < min(sy1, frame.height) {
                var sx = sx0
                while sx < min(sx1, frame.width) {
                    sum += frame.luma(sx, sy)
                    count += 1
                    sx += 1
                }
                sy += 1
            }
            values[gy * gridSize + gx] = count > 0 ? sum / Double(count) : 0
        }
    }

    let mean = values.reduce(0, +) / Double(values.count)
    let variance = values.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(values.count)
    let std = variance.squareRoot()
    guard std > 0.0001 else { return nil }
    return values.map { ($0 - mean) / std }
}

/// How many candidate identities to report per slot.
private let candidateCount = 6

func bestCardMatch(vector: [Double], index: CardIndex, slot: Int) -> CardMatch? {
    let n = Double(vector.count)
    var scored: [(card: IndexedCard, score: Double)] = []
    scored.reserveCapacity(index.cards.count)

    for card in index.cards {
        guard card.vector.count == vector.count else { continue }
        var dot = 0.0
        for i in 0..<vector.count {
            dot += vector[i] * card.vector[i]
        }
        scored.append((card, dot / n))
    }

    guard !scored.isEmpty else { return nil }
    scored.sort { $0.score > $1.score }

    let best = scored[0]
    let runnerUp = scored.count > 1 ? scored[1].score : -1.0
    let alternatives = scored.prefix(candidateCount).map {
        CardCandidate(key: $0.card.key, name: $0.card.name, elixir: $0.card.elixir, type: $0.card.type, score: $0.score)
    }

    return CardMatch(
        slot: slot,
        key: best.card.key,
        name: best.card.name,
        elixir: best.card.elixir,
        type: best.card.type,
        score: best.score,
        margin: best.score - runnerUp,
        alternatives: Array(alternatives)
    )
}

func recognizeCards(_ frame: Frame, index: CardIndex) -> ([CardMatch], CardMatch?) {
    var matches: [CardMatch] = []
    let top = Int(Geometry.cardArtTop * Double(frame.height))
    let bottom = Int(Geometry.cardArtBottom * Double(frame.height))

    for (i, centerX) in Geometry.cardSlotX.enumerated() {
        let x0 = Int((centerX - Geometry.cardHalfWidth) * Double(frame.width))
        let x1 = Int((centerX + Geometry.cardHalfWidth) * Double(frame.width))
        guard let vector = featureVector(frame, x0: x0, y0: top, x1: x1, y1: bottom, gridSize: index.gridSize),
              let match = bestCardMatch(vector: vector, index: index, slot: i + 1) else { continue }
        matches.append(match)
    }

    var next: CardMatch?
    let nx0 = Int((Geometry.nextCardX - Geometry.nextCardHalfWidth) * Double(frame.width))
    let nx1 = Int((Geometry.nextCardX + Geometry.nextCardHalfWidth) * Double(frame.width))
    let ny0 = Int(Geometry.nextCardTop * Double(frame.height))
    let ny1 = Int(Geometry.nextCardBottom * Double(frame.height))
    if let vector = featureVector(frame, x0: nx0, y0: ny0, x1: nx1, y1: ny1, gridSize: index.gridSize) {
        next = bestCardMatch(vector: vector, index: index, slot: 0)
    }

    return (matches, next)
}

// MARK: - Unit detection via health bars

/// Finds horizontal runs of saturated red or blue, which is how Clash Royale
/// draws unit health bars (red = enemy, blue = friendly). Tower bars are also
/// picked up here; they sit at fixed positions and are filtered out by the
/// caller's background model rather than by hardcoded coordinates.
func detectHealthBars(_ frame: Frame) -> [HealthBar] {
    @inline(__always) func isRed(_ p: (Int, Int, Int)) -> Bool {
        let (r, g, b) = p
        return r > 150 && g < 90 && b < 90 && (r - max(g, b)) > 70
    }
    @inline(__always) func isBlue(_ p: (Int, Int, Int)) -> Bool {
        let (r, g, b) = p
        return b > 150 && r < 110 && g < 150 && (b - max(r, g)) > 50
    }

    let yStart = Int(Geometry.arenaTop * Double(frame.height))
    let yEnd = Int(Geometry.arenaBottom * Double(frame.height))
    let xStart = Int(Geometry.arenaLeft * Double(frame.width))
    let xEnd = Int(Geometry.arenaRight * Double(frame.width))
    let minRun = max(8, frame.width / 50)

    var raw: [(String, Int, Int, Int)] = []
    for y in yStart..<yEnd {
        var redRun = 0
        var blueRun = 0
        for x in xStart..<xEnd {
            let p = frame.rgb(x, y)
            if isRed(p) { redRun += 1 } else {
                if redRun >= minRun { raw.append(("opponent", x - redRun / 2, y, redRun)) }
                redRun = 0
            }
            if isBlue(p) { blueRun += 1 } else {
                if blueRun >= minRun { raw.append(("own", x - blueRun / 2, y, blueRun)) }
                blueRun = 0
            }
        }
    }

    // A health bar is several pixels tall, so it produces one run per row.
    // Merge nearby runs into a single unit position.
    var clusters: [(owner: String, x: Int, y: Int, w: Int, count: Int)] = []
    for (owner, x, y, w) in raw {
        var merged = false
        for i in clusters.indices where clusters[i].owner == owner {
            if abs(clusters[i].x - x) < 25 && abs(clusters[i].y - y) < 18 {
                clusters[i].x = (clusters[i].x * clusters[i].count + x) / (clusters[i].count + 1)
                clusters[i].y = (clusters[i].y * clusters[i].count + y) / (clusters[i].count + 1)
                clusters[i].w = max(clusters[i].w, w)
                clusters[i].count += 1
                merged = true
                break
            }
        }
        if !merged { clusters.append((owner, x, y, w, 1)) }
    }

    return clusters.filter { $0.count >= 2 }.map {
        HealthBar(
            owner: $0.owner,
            x: Double($0.x) / Double(frame.width),
            y: Double($0.y) / Double(frame.height),
            width: Double($0.w) / Double(frame.width)
        )
    }
}

// MARK: - Motion

/// Frame-to-frame motion over a fine grid across the arena. Health bars give
/// unit positions when they're visible; motion catches everything else
/// (spells landing, units whose bars are hidden, projectiles).
func detectMotion(prev: Frame, curr: Frame) -> [MotionCell] {
    guard prev.width == curr.width, prev.height == curr.height else { return [] }

    let cols = 12
    let rows = 16
    let yStart = Int(Geometry.arenaTop * Double(curr.height))
    let yEnd = Int(Geometry.arenaBottom * Double(curr.height))
    let xStart = Int(Geometry.arenaLeft * Double(curr.width))
    let xEnd = Int(Geometry.arenaRight * Double(curr.width))

    var sums = [Double](repeating: 0, count: cols * rows)
    var counts = [Int](repeating: 0, count: cols * rows)

    let step = 2
    var y = yStart
    while y < yEnd {
        let row = (y - yStart) * rows / max(1, yEnd - yStart)
        var x = xStart
        while x < xEnd {
            let col = (x - xStart) * cols / max(1, xEnd - xStart)
            let a = prev.rgb(x, y)
            let b = curr.rgb(x, y)
            let delta = Double(abs(a.0 - b.0) + abs(a.1 - b.1) + abs(a.2 - b.2)) / 3.0
            let cell = min(rows - 1, row) * cols + min(cols - 1, col)
            sums[cell] += delta
            counts[cell] += 1
            x += step
        }
        y += step
    }

    var cells: [MotionCell] = []
    let threshold = 14.0
    for r in 0..<rows {
        for c in 0..<cols {
            let i = r * cols + c
            guard counts[i] > 0 else { continue }
            let avg = sums[i] / Double(counts[i])
            guard avg > threshold else { continue }
            let xFraction = Geometry.arenaLeft
                + (Double(c) + 0.5) / Double(cols) * (Geometry.arenaRight - Geometry.arenaLeft)
            let yFraction = Geometry.arenaTop
                + (Double(r) + 0.5) / Double(rows) * (Geometry.arenaBottom - Geometry.arenaTop)
            cells.append(MotionCell(x: xFraction, y: yFraction, intensity: avg))
        }
    }
    return cells
}

// MARK: - OCR

struct OcrOutput {
    let texts: [TextObservation]
    let towerNumbers: [TowerNumber]
    let phase: String?
    let timeRemaining: Int?
    let doubleElixir: Bool
}

func runOcr(imagePath: String) -> OcrOutput {
    guard let image = NSImage(contentsOfFile: imagePath),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return OcrOutput(texts: [], towerNumbers: [], phase: nil, timeRemaining: nil, doubleElixir: false)
    }

    var items: [TextObservation] = []
    let request = VNRecognizeTextRequest { req, _ in
        guard let observations = req.results as? [VNRecognizedTextObservation] else { return }
        for o in observations {
            guard let candidate = o.topCandidates(1).first else { continue }
            let b = o.boundingBox
            // Vision's origin is bottom-left; convert to top-down fractions.
            let topDownY = 1.0 - (b.origin.y + b.size.height)
            items.append(TextObservation(
                text: candidate.string,
                confidence: candidate.confidence,
                x: Double(b.origin.x + b.size.width / 2),
                y: Double(topDownY),
                width: Double(b.size.width),
                height: Double(b.size.height)
            ))
        }
    }
    // Everything OCR is needed for (the clock, tower hit points, victory and
    // overtime banners) is plain digits and short words, so language correction
    // only costs time and can "helpfully" rewrite numbers into words.
    //
    // No regionOfInterest here on purpose: Vision reports bounding boxes in
    // ROI-relative coordinates, which quietly invalidates every positional
    // filter below. OCR is instead kept off the hot path by running it on a
    // schedule (see the --ocr flag) rather than on every frame.
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])

    var phase: String?
    var towerNumbers: [TowerNumber] = []
    var timeRemaining: Int?
    var doubleElixir = false

    for item in items {
        let upper = item.text.uppercased()

        if upper.contains("VICTORY") || upper.contains("DEFEAT") || upper.contains("MATCH OVER") {
            phase = "post-game"
        } else if upper.contains("OVERTIME") || upper.contains("SUDDEN DEATH") {
            if phase != "post-game" { phase = "overtime" }
        }

        if upper.contains("X2") || upper.contains("2X") { doubleElixir = true }

        // "Time left: 0:50" - capture the clock so the tactics layer knows when
        // double elixir and overtime are coming.
        if let range = item.text.range(of: #"(\d):(\d{2})"#, options: .regularExpression) {
            let parts = item.text[range].split(separator: ":")
            if parts.count == 2, let m = Int(parts[0]), let s = Int(parts[1]) {
                let total = m * 60 + s
                if timeRemaining == nil || total < timeRemaining! { timeRemaining = total }
            }
        }

        // Tower hit points. Vision reads these with the crown glyph attached
        // ("My 3052.", "M 2694"), so pull the longest digit run out of the
        // string rather than requiring the whole string to be numeric.
        // Restrict to the arena band, and exclude the top-left player-info box,
        // so the opponent's trophy count can't be mistaken for a tower's HP.
        let inPlayerInfo = item.x < Geometry.playerInfoRight && item.y < Geometry.playerInfoBottom
        if !inPlayerInfo, item.y > Geometry.arenaTop, item.y < Geometry.arenaBottom,
           item.x > 0.05, item.x < 0.95 {
            let runs = item.text.split(whereSeparator: { !$0.isNumber })
            if let longest = runs.max(by: { $0.count < $1.count }),
               longest.count >= 3,
               let value = Double(longest),
               value >= 200, value <= 10000 {
                towerNumbers.append(TowerNumber(value: value, x: item.x, y: item.y))
            }
        }
    }

    // The "x2" badge is a stylized glyph that OCR does not reliably read, but
    // the rule behind it is deterministic: double elixir begins at one minute
    // remaining. Derive it from the clock and treat any OCR hit as a bonus.
    if let remaining = timeRemaining, remaining <= 60 { doubleElixir = true }

    return OcrOutput(
        texts: items,
        towerNumbers: towerNumbers,
        phase: phase,
        timeRemaining: timeRemaining,
        doubleElixir: doubleElixir
    )
}

// MARK: - Input simulation

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

// MARK: - Window listing

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

// MARK: - CLI

let args = CommandLine.arguments
if args.count < 2 {
    print("Usage: helper <command> [args...]")
    print("Commands:")
    print("  window [query]                   Find window matching query (default: 'iPhone Mirroring')")
    print("  list-windows                     List all top-level application windows")
    print("  click <x> <y>                    Click at screen coordinates")
    print("  tap-sequence <x1> <y1> <x2> <y2> [delayMs]  Click first then second location")
    print("  state <currImage> [prevImage]    Full perception pass (cards, elixir, units, OCR)")
    exit(1)
}

let cmd = args[1]
let encoder = JSONEncoder()

switch cmd {
case "window":
    let query = args.count > 2 ? args[2] : "iPhone Mirroring"
    encoder.outputFormatting = .prettyPrinted
    if let win = findWindow(query: query),
       let data = try? encoder.encode(win),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    } else {
        print("{\"error\": \"Window not found matching '\(query)'\"}")
        exit(1)
    }

case "list-windows":
    encoder.outputFormatting = .prettyPrinted
    if let data = try? encoder.encode(listAllWindows()), let json = String(data: data, encoding: .utf8) {
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

case "state":
    // Usage: state <currImage> [prevImage] [--ocr]
    // OCR costs roughly as much as everything else combined, and the things it
    // reads (clock, tower hit points) change slowly enough to be tracked
    // between passes, so the caller asks for it explicitly.
    let positional = args.dropFirst(2).filter { !$0.hasPrefix("--") }
    let wantOcr = args.contains("--ocr")

    guard let currPath = positional.first, let frame = loadFrame(currPath) else {
        fputs("Usage: helper state <currImage> [prevImage] [--ocr]\n", stderr)
        exit(1)
    }

    let elixir = readElixir(frame)
    let inBattle = elixir != nil

    var cards: [CardMatch] = []
    var nextCard: CardMatch?
    if inBattle, let index = loadCardIndex() {
        (cards, nextCard) = recognizeCards(frame, index: index)
    }

    var motion: [MotionCell] = []
    if positional.count >= 2, let prev = loadFrame(positional[positional.index(positional.startIndex, offsetBy: 1)]) {
        motion = detectMotion(prev: prev, curr: frame)
    }

    let ocr = wantOcr
        ? runOcr(imagePath: currPath)
        : OcrOutput(texts: [], towerNumbers: [], phase: nil, timeRemaining: nil, doubleElixir: false)
    var phase = ocr.phase
    if phase == nil { phase = inBattle ? "in-progress" : "menu" }

    let result = GameStateResult(
        inBattle: inBattle,
        elixir: elixir,
        doubleElixir: ocr.doubleElixir,
        cards: cards,
        nextCard: nextCard,
        healthBars: inBattle ? detectHealthBars(frame) : [],
        motion: motion,
        towerNumbers: ocr.towerNumbers,
        detectedPhase: phase,
        timeRemainingSeconds: ocr.timeRemaining,
        rawTexts: ocr.texts
    )

    if let data = try? encoder.encode(result), let json = String(data: data, encoding: .utf8) {
        print(json)
    }

default:
    fputs("Unknown command: \(cmd)\n", stderr)
    exit(1)
}
