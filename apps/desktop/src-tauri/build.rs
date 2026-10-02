fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["native_attach", "native_post", "native_drain"]),
    ))
    .expect("desktop configuration");
}
