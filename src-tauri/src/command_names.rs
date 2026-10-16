// The one list of Coffer IPC commands. `build.rs` includes this file for the
// app manifest (so each command gets an `allow-*` permission), and the crate
// includes it for the tests that compare it with `src/lib/contract.ts` and with
// the two capability files. Keep it in the order of the contract.

/// Every command in `Commands` of `src/lib/contract.ts`, plus the shell
/// additions in `SHELL_ADDED_COMMANDS`.
pub const COMMAND_NAMES: &[&str] = &[
    "app_info",
    "folder_info",
    "folder_pick",
    "vault_status",
    "vault_create",
    "secret_key_rotate",
    "vault_open",
    "vault_unlock",
    "vault_unlock_hello",
    "vault_lock",
    "vault_change_password",
    "vault_move",
    "vault_save_again",
    "vault_open_older",
    "hello_set",
    "secret_key_validate",
    "emergency_kit",
    "kdf_benchmark",
    "items_list",
    "item_get",
    "item_reveal",
    "item_copy",
    "item_save",
    "item_patch",
    "item_set_state",
    "items_bulk",
    "item_delete_forever",
    "trash_empty",
    "item_revisions",
    "item_restore_revision",
    "item_password_history",
    "item_open_url",
    "totp_code",
    "totp_parse",
    "totp_from_image",
    "ssh_generate",
    "generate",
    "generator_copy",
    "generator_history",
    "generator_history_reveal",
    "generator_history_copy",
    "generator_history_clear",
    "password_strength",
    "health_report",
    "health_check_breaches",
    "import_preview",
    "import_commit",
    "import_undo",
    "import_delete_source",
    "export_vault",
    "backups_list",
    "backup_restore",
    "settings_get",
    "settings_set",
    "quick_hint_seen",
    "edit_state",
    "quick_context",
    "quick_hide",
    "quick_set_modal",
    "main_show",
    "autotype",
    "app_quit",
    "main_hide",
];

/// Commands the shell needs that are not (yet) in the contract (none now).
pub const SHELL_ADDED_COMMANDS: &[&str] = &[];

/// The commands the Quick Access window may call (SPEC 3.7). Every other
/// command is for the main window only, except `QUICK_ONLY_COMMANDS`.
pub const QUICK_COMMANDS: &[&str] = &[
    "app_info",
    "settings_get",
    "quick_hint_seen",
    "vault_status",
    "vault_unlock",
    "vault_unlock_hello",
    "vault_lock",
    "items_list",
    "item_get",
    "item_copy",
    "item_open_url",
    "totp_code",
    "autotype",
    "quick_context",
    "quick_hide",
    "quick_set_modal",
    "main_show",
    "generate",
    "generator_copy",
];

/// Commands that only the Quick Access window may call.
pub const QUICK_ONLY_COMMANDS: &[&str] = &["quick_context", "quick_hide", "quick_set_modal", "quick_hint_seen", "autotype"];
