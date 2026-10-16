// Only the listed commands exist for permissions (SPEC 3.7): with an app
// manifest, an app command is callable only from a window whose capability
// grants its `allow-<command>` permission.
#[allow(dead_code)]
mod names {
    include!("src/command_names.rs");
}

fn main() {
    println!("cargo:rerun-if-changed=src/command_names.rs");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(names::COMMAND_NAMES)),
    )
    .expect("failed to run tauri-build");
}
