#[test]
fn native_tests_keep_the_runtime_in_packaged_mode() {
    assert!(
        !tauri::is_dev(),
        "Run native tests with pnpm run test:native so Cargo preserves the packaged runtime"
    );
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let index = context.assets().get(&"index.html".into())
        .expect("the packaged runtime must embed its frontend entry point");
    let html = std::str::from_utf8(&index).expect("the frontend entry point must be UTF-8");
    assert!(html.contains("id=\"root\""), "the embedded frontend must mount the application");
}
