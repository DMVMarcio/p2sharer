fn main() {
    println!("cargo:rerun-if-changed=native/nvenc");
    println!("cargo:rerun-if-changed=native/mf");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        cc::Build::new().cpp(true).file("native/nvenc/encoder.cpp")
            .flag_if_supported("/std:c++17").flag_if_supported("/EHsc").compile("p2sharer_nvenc");
        cc::Build::new().cpp(true).file("native/mf/encoder.cpp")
            // Keep the existing VC runtime baseline instead of adding VCRUNTIME140_1.
            .flag_if_supported("/std:c++17").flag_if_supported("/EHsc")
            .flag_if_supported("/d2FH4-").compile("p2sharer_mf");
        for library in ["mfplat", "mf", "mfuuid", "ole32", "oleaut32", "d3d11", "dxgi"] {
            println!("cargo:rustc-link-lib={library}");
        }
        println!("cargo:rustc-link-lib=delayimp");
        println!("cargo:rustc-link-arg=delayimp.lib");
        println!("cargo:rustc-link-arg=/DELAYLOAD:mfplat.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
    }
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    let windows = tauri_build::WindowsAttributes::new()
        .window_icon_path("icons/icon.ico");

    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(windows)
    ).expect("failed to run tauri-build");
}

