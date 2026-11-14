// Saves the pointers macOS draws (arrow, hand, text beam) as PNGs, with where each one
// points: compose.py draws them into a film made from inside Zotero.
//   swift cursors.swift <folder>
import AppKit

_ = NSApplication.shared
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
var spots: [String: [CGFloat]] = [:]
for (name, cursor) in [("arrow", NSCursor.arrow), ("pointer", NSCursor.pointingHand), ("text", NSCursor.iBeam)] {
	// The TIFF holds every size the system has of it; the bitmap made from it is the largest.
	guard let tiff = cursor.image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
		let png = bitmap.representation(using: .png, properties: [:]) else {
		fatalError("macOS gave no image for the \(name) pointer")
	}
	try png.write(to: folder.appendingPathComponent(name + ".png"))
	// In points: the spot that points, then the size the image is drawn at.
	spots[name] = [cursor.hotSpot.x, cursor.hotSpot.y, cursor.image.size.width, cursor.image.size.height]
}
try JSONSerialization.data(withJSONObject: spots).write(to: folder.appendingPathComponent("spots.json"))
