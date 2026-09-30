import Foundation
import Capacitor
import Vision
import Photos
import UIKit
import CoreLocation

/// The three things the web app cannot do for itself inside a WKWebView.
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
///
/// `getLocation` returns one GPS fix through iOS location services.
/// WKWebView's navigator.geolocation is unreliable inside Capacitor and never
/// prompts without NSLocationWhenInUseUsageDescription in the app's
/// Info.plist, so the photo timestamp stamp calls this first and only falls
/// back to the web API.
@objc(MercuryNativePlugin)
public class MercuryNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MercuryNativePlugin"
    public let jsName = "MercuryNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognizeText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "savePhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openFile", returnType: CAPPluginReturnPromise)
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

    // MARK: - Location

    private var locationManager: CLLocationManager?
    private var pendingLocationCall: CAPPluginCall?
    private var bestLocation: CLLocation?
    private var documentController: UIDocumentInteractionController?

    /// Presents the iOS "Open In…" menu for a downloaded file (spreadsheet,
    /// invoice PDF, backup) so it can be opened directly in Excel etc.
    /// WKWebView can't do `<a download>`, and the share sheet buries the
    /// target app — this lists every app that handles the file type.
    @objc func openFile(_ call: CAPPluginCall) {
        guard let filename = call.getString("filename"), !filename.isEmpty else {
            call.reject("The download had no filename.")
            return
        }
        guard let data = Self.decodeData(call.getString("data") ?? "") else {
            call.reject("The download could not be read.")
            return
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(filename)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            call.reject("Could not stage the download: \(error.localizedDescription)")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, let viewController = self.bridge?.viewController else {
                call.reject("The app window isn't ready.")
                return
            }
            let controller = UIDocumentInteractionController(url: url)
            controller.delegate = self
            self.documentController = controller // strong ref while presented
            if !controller.presentOpenInMenu(
                from: viewController.view.bounds,
                in: viewController.view,
                animated: true
            ) {
                // No app claims the type — fall back to a preview, which
                // still offers its own "Open In".
                controller.presentPreview(animated: true)
            }
            call.resolve()
        }
    }

    /// One-shot GPS fix for the photo timestamp stamp. Asks iOS for its best
    /// fix and lets the receiver converge (the way Maps does) instead of
    /// taking the first coarse Wi-Fi/cell fix: house-level precision needs
    /// ~15 m accuracy, and a stale/coarse cached fix is what stamped
    /// addresses 3–4 houses off.
    /// Resolves `{latitude, longitude, accuracy}` or rejects with a
    /// human-readable reason the web side surfaces in the stamp/toast.
    @objc func getLocation(_ call: CAPPluginCall) {
        switch CLLocationManager.authorizationStatus() {
        case .denied, .restricted:
            call.reject("Location is turned off for Mercury. Turn it on in " +
                        "Settings › Mercury › Location (\"While Using\" is enough).")
            return
        default:
            break
        }

        pendingLocationCall = call
        bestLocation = nil
        let manager = CLLocationManager()
        manager.delegate = self
        // House-level precision: best accuracy, then keep sampling until a
        // fix is good enough or time runs out. Ten-meter "good enough"
        // fixes off Wi-Fi/cell arrive in a second or two; a true GPS fix
        // takes a few seconds longer but pins the right house.
        manager.desiredAccuracy = kCLLocationAccuracyBest
        locationManager = manager

        // Only trust a cached fix when it's fresh AND already precise — a
        // stale or coarse fix is what used to stamp 3–4 houses away.
        if let cached = manager.location,
           cached.timestamp.timeIntervalSinceNow > -60,
           cached.horizontalAccuracy > 0, cached.horizontalAccuracy <= 20 {
            finishLocation(with: cached)
            return
        }

        if CLLocationManager.authorizationStatus() == .notDetermined {
            manager.requestWhenInUseAuthorization()
            // startUpdatingLocation() fires from locationManagerDidChangeAuthorization
            // once the user answers the prompt.
        } else {
            manager.startUpdatingLocation()
        }

        // Up to 15 s for the GPS to converge; the best fix seen wins, even
        // if it never reaches the early-finish threshold.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self else { return }
            self.finishLocationWithBest()
        }
    }

    private func finishLocation(with location: CLLocation) {
        guard let pending = pendingLocationCall else { return }
        pendingLocationCall = nil
        bestLocation = nil
        locationManager = nil
        pending.resolve([
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy,
        ])
    }

    /// Timeout path: keep the best fix the receiver produced rather than
    /// failing outright — a 40 m fix still beats stamping date/time only.
    private func finishLocationWithBest() {
        guard pendingLocationCall != nil else { return }
        if let best = bestLocation {
            finishLocation(with: best)
        } else {
            failLocation("Location timed out waiting for a GPS fix.")
        }
    }

    private func failLocation(_ message: String) {
        guard let pending = pendingLocationCall else { return }
        pendingLocationCall = nil
        bestLocation = nil
        locationManager = nil
        pending.reject(message)
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

// MARK: - UIDocumentInteractionControllerDelegate

extension MercuryNativePlugin: UIDocumentInteractionControllerDelegate {
    public func documentInteractionControllerViewControllerForPreview(
        _ controller: UIDocumentInteractionController
    ) -> UIViewController {
        bridge?.viewController ?? UIViewController()
    }
}

// MARK: - CLLocationManagerDelegate

extension MercuryNativePlugin: CLLocationManagerDelegate {
    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            // The prompt was answered with "allow" — now take the fix.
            if pendingLocationCall != nil {
                manager.startUpdatingLocation()
            }
        case .denied, .restricted:
            if pendingLocationCall != nil {
                failLocation("Location is turned off for Mercury. Turn it on in " +
                             "Settings › Mercury › Location (\"While Using\" is enough).")
            }
        default:
            break
        }
    }

    public func locationManager(_ manager: CLLocationManager,
                                didUpdateLocations locations: [CLLocation]) {
        for location in locations {
            // iOS replays stale fixes when an update stream starts; ignore
            // those and anything invalid, and keep the sharpest fix seen.
            guard location.horizontalAccuracy > 0,
                  location.timestamp.timeIntervalSinceNow > -10 else { continue }
            if bestLocation == nil
                || location.horizontalAccuracy < bestLocation!.horizontalAccuracy {
                bestLocation = location
            }
            // House-level precision reached — stop the GPS early.
            if location.horizontalAccuracy <= 15 {
                finishLocation(with: location)
                return
            }
        }
    }

    public func locationManager(_ manager: CLLocationManager,
                                didFailWithError error: Error) {
        failLocation(error.localizedDescription)
    }
}
