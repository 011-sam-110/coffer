//! Coffer's app shell: Tauri setup, tray, windows, hotkeys, lock signals,
//! clipboard, device files and the IPC commands of `src/lib/contract.ts`.

#[cfg(not(windows))]
compile_error!("Coffer's app shell builds on Windows only (coffer-core is portable).");

#[macro_use]
mod logging;
mod autostart;
mod autotype;
mod clipboard;
mod clock;
// Used by build.rs and the contract tests.
#[cfg_attr(not(test), allow(dead_code))]
mod command_names;
mod commands;
mod contract;
#[cfg(test)]
mod contract_tests;
mod device;
mod error;
mod folders;
mod hello;
mod hibp;
mod hotkeys;
mod lock;
mod paths;
mod placement;
#[cfg(debug_assertions)]
mod selftest;
mod settings;
mod shell;
mod ssh;
mod state;
mod totp_image;
mod tray;
mod usage;
mod vault;
mod win;

use std::sync::atomic::Ordering;

use tauri::Manager;

use state::{AppState, RwExt};

/// Calls `$m!(every command)`: one list for the handler and for the test that
/// compares it with `COMMAND_NAMES`.
macro_rules! with_commands {
    ($m:ident) => {
        $m!(
            app_info, folder_info, folder_pick,
            vault_status, vault_create, secret_key_rotate, vault_open, vault_unlock, vault_unlock_hello, vault_lock,
            vault_change_password, vault_move, vault_save_again, vault_open_older, hello_set, secret_key_validate,
            emergency_kit, kdf_benchmark,
            items_list, item_get, item_reveal, item_copy, item_save, item_patch, item_set_state, items_bulk,
            item_delete_forever, trash_empty, item_revisions, item_restore_revision, item_password_history,
            item_open_url, totp_code, totp_parse, totp_from_image, ssh_generate,
            generate, generator_options, generator_copy, generator_history, generator_history_reveal, generator_history_copy,
            generator_history_clear, password_strength,
            health_report, health_check_breaches,
            import_preview, import_commit, import_undo, import_delete_source, export_vault,
            backups_list, backup_restore,
            settings_get, settings_set, quick_hint_seen, edit_state,
            quick_context, quick_hide, quick_set_modal, main_show, autotype, app_quit,
            main_hide
        )
    };
}

macro_rules! handler {
    ($($name:ident),* $(,)?) => { tauri::generate_handler![$(commands::$name),*] };
}

#[cfg(test)]
macro_rules! names {
    ($($name:ident),* $(,)?) => { &[$(stringify!($name)),*] };
}

#[cfg(test)]
pub(crate) const REGISTERED_COMMANDS: &[&str] = with_commands!(names);

pub fn run() {
    let data_dir = paths::data_dir();
    logging::init(&data_dir);
    let (settings_file, first_run) = settings::load(&data_dir.join("settings.json"));
    let hidden_arg = std::env::args().any(|a| a == "--hidden");
    log!("start: Coffer {} hiddenArg={hidden_arg} firstRun={first_run}", env!("CARGO_PKG_VERSION"));
    let app_state = AppState::new(data_dir, settings_file, first_run);

    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch shows the running Coffer and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            log!("second launch");
            if !argv.iter().any(|a| a == "--hidden") {
                shell::show_main(app, None);
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .manage(app_state)
        .setup(move |app| {
            let handle = app.handle().clone();
            win::set_app(&handle);
            win::signals::start();
            vault::start_watcher(&handle);
            hello::start(&handle);
            shell::create_windows(&handle)?;
            tray::create(&handle)?;
            log!("tray ready");
            {
                // The plugin registers on the main thread; do not wait for it here.
                let handle = handle.clone();
                let _ = std::thread::Builder::new().name("coffer-hotkeys".into()).spawn(move || {
                    hotkeys::apply(&handle);
                });
            }
            let (start_hidden, has_vault) = {
                let s = handle.state::<AppState>().settings.rd().clone();
                (s.settings.start_hidden, s.vault_path.is_some())
            };
            if shell::show_main_at_start(hidden_arg, start_hidden, has_vault) {
                shell::show_main(&handle, None);
            }
            #[cfg(debug_assertions)]
            selftest::maybe_start(&handle);
            Ok(())
        })
        .on_window_event(shell::on_window_event)
        .invoke_handler(with_commands!(handler))
        .build(tauri::generate_context!())
        .expect("Coffer could not start");

    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            // Closing the last window does not quit: Coffer lives in the tray.
            if code.is_none() && !app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            clipboard::clear_if_ours(app);
            log!("exit");
        }
        _ => {}
    });
}
