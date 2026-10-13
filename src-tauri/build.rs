fn main() {
    println!("cargo:rerun-if-changed=native/nvenc");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        cc::Build::new().cpp(true).file("native/nvenc/encoder.cpp")
            .flag_if_supported("/std:c++17").flag_if_supported("/EHsc").compile("p2sharer_nvenc");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=native/macos/audio.m");
        cc::Build::new().file("native/macos/audio.m")
            .flag("-fobjc-arc").flag("-fblocks").flag("-mmacosx-version-min=13.0")
            .compile("p2sharer_macos_audio");
        for framework in ["Foundation", "AppKit", "ScreenCaptureKit", "CoreMedia", "CoreAudio", "CoreGraphics"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    let windows = tauri_build::WindowsAttributes::new()
        .window_icon_path("icons/icon.ico");

    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(windows)
    ).expect("failed to run tauri-build");
}

