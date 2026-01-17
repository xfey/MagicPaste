// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MagicPasteNative",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "MagicPasteNative", targets: ["MagicPasteNative"]),
        .executable(name: "ContextProbe", targets: ["ContextProbe"])
    ],
    targets: [
        .executableTarget(
            name: "MagicPasteNative",
            path: "Sources/MagicPasteNative"
        ),
        .executableTarget(
            name: "ContextProbe",
            path: "Sources/ContextProbe"
        )
    ]
)
