import Foundation
import Capacitor
import Vision
import Photos
import UIKit

/// The two things the web app cannot do for itself inside a WKWebView.
///
/// `recognizeText` runs Apple's on-device text recognition (the Vision
/// framework, the same engine behind Live Text / Visual Intelligence). It
/// replaces the bundled Tesseract build: it is markedly more accurate on
/// equipment labels, needs no ~9.7 MB of wasm shipped to the phone, and is
/// genuinely offline — no model to download, nothing to warm up.
///
/// `savePhotos` writes the compressed JPEGs straight into the camera roll.
/// Safari's PWA could lean on the Web Share API for this ("Save N Images"),
/// but WKWebView does not implement sharing files and silently ignores
/// `<a download>`, so in the packaged app the web fallback does nothing at
/// all. This is the native path that makes "Save all" work there.
@objc(MercuryNativePlugin)
public class MercuryNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MercuryNativePlugin"
    public let jsName = "MercuryNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognizeText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "savePhotos", returnType: CAPPluginReturnPromise)
    ]

    // MARK: - OCR

    @objc func recognizeText(_ call: CAPPluginCall) {
        guard let images = call.getArray("images", String.self), !images.isEmpty else {
            call.reject("No images were provided to read.")
            return
        }

        // Vision is synchronous and CPU-heavy; keep it off the main thread so
        // the web view stays responsive while a batch is read.
        DispatchQueue.global(qos: .userInitiated).async {
            var texts: [String] = []
            for encoded in images {
                guard let image = Self.decodeCGImage(encoded) else {
                    // One unreadable photo must not sink the batch — the page
                    // pairs results with inputs by position, so keep the slot.
                    texts.append("")
                    continue
                }
                texts.append(Self.recognizeText(in: image))
            }
            call.resolve(["texts": texts])
        }
    }

    private static func recognizeText(in image: CGImage) -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        // Off, deliberately. These labels are MACs, FSANs and serial numbers,
        // not prose: language correction "helpfully" rewrites strings like
        // CXNK01C0DC59 into something word-shaped and ruins the read.
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return ""
        }

        return (request.results ?? [])
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n")
    }

    private static func decodeCGImage(_ encoded: String) -> CGImage? {
        guard let data = decodeData(encoded) else { return nil }
        return UIImage(data: data)?.cgImage
    }

    // MARK: - Saving to the camera roll

    @objc func savePhotos(_ call: CAPPluginCall) {
        guard let images = call.getArray("images", String.self), !images.isEmpty else {
            call.reject("No photos were provided to save.")
            return
        }

        let payloads = images.compactMap { Self.decodeData($0) }
        guard !payloads.isEmpty else {
            call.reject("Those photos could not be read.")
            return
        }

        requestAddOnlyAccess { granted in
            guard granted else {
                call.reject("Mercury isn't allowed to add photos. Turn it on in "
                            + "Settings › Mercury › Photos (\"Add Photos Only\" is enough).")
                return
            }

            PHPhotoLibrary.shared().performChanges({
                for data in payloads {
                    // addResource(with:data:) stores the JPEG bytes as-is, so the
                    // camera roll gets the compressed file rather than a re-encode.
                    PHAssetCreationRequest.forAsset()
                        .addResource(with: .photo, data: data, options: nil)
                }
            }, completionHandler: { success, error in
                if success {
                    call.resolve(["saved": payloads.count])
                } else {
                    call.reject(error?.localizedDescription
                                ?? "The photos could not be saved to your library.")
                }
            })
        }
    }

    /// Add-only is the narrowest permission that allows writing to the camera
    /// roll, and unlike full access it does not ask for read access to every
    /// photo on the phone. It is backed by NSPhotoLibraryAddUsageDescription.
    private func requestAddOnlyAccess(_ completion: @escaping (Bool) -> Void) {
        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        switch status {
        case .authorized, .limited:
            completion(true)
        case .notDetermined:
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { granted in
                completion(granted == .authorized || granted == .limited)
            }
        default:
            completion(false)
        }
    }

    // MARK: - Shared

    /// Accepts either a bare base64 string or a full `data:image/jpeg;base64,…`
    /// URL, since the page has reason to produce both.
    private static func decodeData(_ encoded: String) -> Data? {
        var base64 = encoded
        if let comma = encoded.firstIndex(of: ","), encoded.hasPrefix("data:") {
            base64 = String(encoded[encoded.index(after: comma)...])
        }
        return Data(base64Encoded: base64, options: .ignoreUnknownCharacters)
    }
}
