/** Interpreted once per recognizer; no generated executable or cached OCR result. */
export const visionSource = String.raw`
import Foundation
import Vision
import Darwin
import CoreGraphics

struct Input: Decodable {
    let id: Int
    let image: String
}
struct Output: Encodable {
    let id: Int
    let text: String
    let confidence: Float
}
struct Failure: Encodable {
    let id: Int
    let error: Bool
}
func emit<T: Encodable>(_ value: T) {
    guard let data = try? JSONEncoder().encode(value) else { exit(1) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
request.usesLanguageCorrection = false
// Force Vision setup before publishing readiness, outside dispatch measurement.
do {
    _ = try request.supportedRecognitionLanguages()
    guard let context = CGContext(data: nil, width: 128, height: 64,
                                  bitsPerComponent: 8, bytesPerRow: 128,
                                  space: CGColorSpaceCreateDeviceGray(),
                                  bitmapInfo: CGImageAlphaInfo.none.rawValue) else { exit(1) }
    context.setFillColor(gray: 1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: 128, height: 64))
    guard let warmImage = context.makeImage() else { exit(1) }
    try VNImageRequestHandler(cgImage: warmImage, options: [:]).perform([request])
} catch {
    exit(1)
}
FileHandle.standardOutput.write(Data("FLASHAct_VISION_READY_1\n".utf8))
while let line = readLine() {
    autoreleasepool {
        guard line.utf8.count <= 5_592_512,
              let input = try? JSONDecoder().decode(Input.self, from: Data(line.utf8)),
              input.id > 0,
              let data = Data(base64Encoded: input.image),
              data.count <= 4_194_304,
              data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) else { exit(1) }
        do {
            try VNImageRequestHandler(data: data, options: [:]).perform([request])
            let observations = request.results ?? []
            guard observations.count == 1,
                  let observation = observations.first,
                  let best = observation.topCandidates(2).first,
                  !best.string.isEmpty,
                  best.string.utf8.count <= 256,
                  best.string.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else {
                emit(Output(id: input.id, text: "", confidence: 0))
                return
            }
            let candidates = observation.topCandidates(2)
            if candidates.count > 1,
               let alternative = candidates.last,
               alternative.string != best.string,
               best.confidence - alternative.confidence < 0.1 {
                emit(Output(id: input.id, text: "", confidence: 0))
                return
            }
            emit(Output(id: input.id, text: best.string, confidence: best.confidence))
        } catch {
            emit(Failure(id: input.id, error: true))
        }
    }
}
`;
