fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // The bundle still supports 10.13, where the legacy notification backend is used.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,UserNotifications");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["native_attach", "native_post", "native_drain"]),
    ))
    .expect("desktop configuration");
}
