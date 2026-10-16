//! Item model (SPEC 4) and the IPC types of `src/lib/contract.ts`.
//!
//! Contract types use `#[serde(rename_all = "camelCase")]` and serialise to
//! exactly the TypeScript shapes. The stored record types ([`StoredItem`],
//! [`StoredField`], ...) are the plaintext inside an encrypted vault record;
//! they use the snake_case names of SPEC 4 and zero their strings on drop.

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

// ---------------------------------------------------------------- enums

/// Item type (contract `ItemType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemType {
    /// Login: username, password, one-time code, URLs.
    Login,
    /// A lone password.
    Password,
    /// Secure note.
    Note,
    /// Credit card.
    Card,
    /// Identity.
    Identity,
    /// Bank account.
    Bank,
    /// ID document (passport, driving licence, ...).
    Document,
    /// SSH key.
    SshKey,
    /// API credential.
    ApiCredential,
    /// Wi-Fi network.
    Wifi,
    /// Software licence.
    License,
}

impl ItemType {
    /// Every type, in sidebar order.
    pub const ALL: [ItemType; 11] = [
        ItemType::Login,
        ItemType::Password,
        ItemType::Note,
        ItemType::Card,
        ItemType::Identity,
        ItemType::Bank,
        ItemType::Document,
        ItemType::SshKey,
        ItemType::ApiCredential,
        ItemType::Wifi,
        ItemType::License,
    ];

    /// The contract string ("login", "sshKey", ...).
    pub fn as_str(&self) -> &'static str {
        match self {
            ItemType::Login => "login",
            ItemType::Password => "password",
            ItemType::Note => "note",
            ItemType::Card => "card",
            ItemType::Identity => "identity",
            ItemType::Bank => "bank",
            ItemType::Document => "document",
            ItemType::SshKey => "sshKey",
            ItemType::ApiCredential => "apiCredential",
            ItemType::Wifi => "wifi",
            ItemType::License => "license",
        }
    }
}

/// Item state (contract `ItemState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemState {
    /// In lists, Quick Access and health.
    Active,
    /// Hidden from lists, Quick Access and health; kept.
    Archived,
    /// In Trash; purged 30 days after `trashed_at`.
    Trashed,
}

/// Field kind (contract `FieldKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldKind {
    /// Plain text.
    Text,
    /// Secret text (masked).
    Concealed,
    /// Multi-line text.
    Multiline,
    /// E-mail address.
    Email,
    /// URL.
    Url,
    /// Phone number.
    Phone,
    /// `YYYY-MM-DD`.
    Date,
    /// `YYYY-MM`.
    MonthYear,
    /// otpauth:// URI or base32 secret (masked).
    Totp,
    /// "true" | "false".
    Boolean,
    /// Card number (masked).
    CardNumber,
    /// PIN (masked).
    Pin,
    /// One of `options`.
    Menu,
    /// Secret multi-line text (masked), e.g. an SSH private key.
    ConcealedMultiline,
}

impl FieldKind {
    /// Kinds whose value is masked in `ItemView` and leaves Rust only by
    /// `item_reveal` (contract `SECRET_KINDS`).
    pub fn is_secret(&self) -> bool {
        matches!(
            self,
            FieldKind::Concealed | FieldKind::ConcealedMultiline | FieldKind::Totp | FieldKind::CardNumber | FieldKind::Pin
        )
    }
}

// ---------------------------------------------------------------- contract types

/// One field as the UI sees it (contract `Field`). In an [`ItemView`] a secret
/// field has `value: ""` and `masked: Some(true)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    /// Field id (unique in the item).
    pub id: String,
    /// Label shown to the user.
    pub label: String,
    /// Kind.
    pub kind: FieldKind,
    /// Plain value, or "" when masked.
    pub value: String,
    /// `Some(true)` for a masked secret field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub masked: Option<bool>,
    /// Optional section name.
    #[serde(default)]
    pub section: Option<String>,
    /// Built-in role ("username", "password", "totp", "number", ...).
    #[serde(default)]
    pub builtin: Option<String>,
    /// Choices for kind "menu".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

/// One URL of an item (contract `ItemUrl`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize)]
#[serde(rename_all = "camelCase")]
pub struct ItemUrl {
    /// The URL text.
    pub url: String,
    /// Optional label.
    #[serde(default)]
    pub label: Option<String>,
}

/// Attachment metadata (tier 3; always empty in v1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Id.
    pub id: String,
    /// File name.
    pub name: String,
    /// Bytes.
    pub size: u64,
    /// MIME type.
    pub mime: String,
}

/// Health flags of one item (contract `ItemFlags`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemFlags {
    /// zxcvbn score 0 to 2.
    pub weak: bool,
    /// Password used in another active item that is not a duplicate.
    pub reused: bool,
    /// Found in Pwned Passwords.
    pub breached: bool,
    /// Has an http:// URL (not localhost or a private address).
    pub unsecured: bool,
    /// Expires soon or has expired.
    pub expiring: bool,
}

/// List row; holds no secret (contract `ItemSummary`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    /// Item id.
    pub id: String,
    /// Type.
    #[serde(rename = "type")]
    pub item_type: ItemType,
    /// Title.
    pub title: String,
    /// Username, masked card number "•••• 4242", etc.
    pub subtitle: String,
    /// Favourite.
    pub favorite: bool,
    /// Tags.
    pub tags: Vec<String>,
    /// State.
    pub state: ItemState,
    /// Last update time.
    pub updated_at: String,
    /// Last use; always `None` from the core (usage lives in the shell's usage.json).
    pub last_used_at: Option<String>,
    /// Host of the first URL ("github.com").
    pub url_host: Option<String>,
    /// Has a non-empty TOTP field.
    pub has_totp: bool,
    /// Health flags.
    pub flags: ItemFlags,
}

/// Detail view; secret fields masked (contract `ItemView`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    /// Item id.
    pub id: String,
    /// Record revision (pass as `baseRev` when saving).
    pub rev: u64,
    /// Type.
    #[serde(rename = "type")]
    pub item_type: ItemType,
    /// Title.
    pub title: String,
    /// Subtitle (no secret).
    pub subtitle: String,
    /// Favourite.
    pub favorite: bool,
    /// Tags.
    pub tags: Vec<String>,
    /// State.
    pub state: ItemState,
    /// Creation time.
    pub created_at: String,
    /// Last update time.
    pub updated_at: String,
    /// When it went to Trash.
    pub trashed_at: Option<String>,
    /// When the built-in password last changed.
    pub password_changed_at: Option<String>,
    /// Fields (secret kinds masked).
    pub fields: Vec<Field>,
    /// Notes (Markdown subset).
    pub notes: String,
    /// URLs.
    pub urls: Vec<ItemUrl>,
    /// Exe names for Quick Access suggestions.
    pub apps: Vec<String>,
    /// Ask for the master password again.
    pub reprompt: bool,
    /// Auto-type sequence.
    pub autotype_sequence: Option<String>,
    /// Excluded from health.
    pub health_excluded: bool,
    /// Attachments (tier 3; empty).
    pub attachments: Vec<Attachment>,
    /// Number of password history entries.
    pub password_history_count: usize,
    /// Health flags.
    pub flags: ItemFlags,
}

/// One field of an [`ItemInput`]. For a secret kind, `value: None` keeps the
/// stored value of the field with the same id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInput {
    /// Field id; empty or unknown = a new field.
    #[serde(default)]
    pub id: String,
    /// Label.
    pub label: String,
    /// Kind.
    pub kind: FieldKind,
    /// Value; `None` = keep the stored value (secret kinds).
    pub value: Option<String>,
    /// Section.
    #[serde(default)]
    pub section: Option<String>,
    /// Built-in role.
    #[serde(default)]
    pub builtin: Option<String>,
    /// Menu choices.
    #[serde(default)]
    pub options: Option<Vec<String>>,
}

/// Create (no id) or update (id + baseRev) (contract `ItemInput`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInput {
    /// Existing id for an update.
    #[serde(default)]
    pub id: Option<String>,
    /// The rev the edit started from.
    #[serde(default)]
    pub base_rev: Option<u64>,
    /// Type.
    #[serde(rename = "type")]
    pub item_type: ItemType,
    /// Title.
    pub title: String,
    /// Favourite.
    #[serde(default)]
    pub favorite: bool,
    /// Tags.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Fields.
    #[serde(default)]
    pub fields: Vec<FieldInput>,
    /// Notes.
    #[serde(default)]
    pub notes: String,
    /// URLs.
    #[serde(default)]
    pub urls: Vec<ItemUrl>,
    /// Apps.
    #[serde(default)]
    pub apps: Vec<String>,
    /// Re-prompt.
    #[serde(default)]
    pub reprompt: bool,
    /// Auto-type sequence.
    #[serde(default)]
    pub autotype_sequence: Option<String>,
    /// Excluded from health.
    #[serde(default)]
    pub health_excluded: bool,
}

/// One saved revision (contract `Revision`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    /// Rev of the snapshot.
    pub rev: u64,
    /// When it was saved.
    pub saved_at: String,
    /// Title at that rev.
    pub title: String,
}

/// Masked password history entry (contract `PasswordHistoryEntry`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordHistoryEntry {
    /// Entry id; reveal with field ref `history:<id>`.
    pub id: String,
    /// When this value stopped being the password.
    pub changed_at: String,
    /// Length in characters.
    pub length: usize,
}

/// A TOTP code (contract `TotpCode`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpCode {
    /// The code.
    pub code: String,
    /// Period in seconds.
    pub period: u64,
    /// Seconds left in this period.
    pub remaining: u64,
}

/// Generator mode (contract `GeneratorMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GeneratorMode {
    /// Random characters.
    Random,
    /// EFF words.
    Passphrase,
    /// Digits.
    Pin,
}

/// Generator options (contract `GeneratorOptions`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneratorOptions {
    /// Mode.
    pub mode: GeneratorMode,
    /// Random 8..128 (default 20); PIN 4..12 (default 6).
    pub length: u32,
    /// A-Z.
    pub upper: bool,
    /// a-z.
    pub lower: bool,
    /// 0-9.
    pub digits: bool,
    /// Symbols `!@#$%^&*()-_=+[]{};:,.?/`.
    pub symbols: bool,
    /// Minimum digits 0..9.
    pub min_digits: u32,
    /// Minimum symbols 0..9.
    pub min_symbols: u32,
    /// Drop `0O1lI|`.
    pub avoid_ambiguous: bool,
    /// Characters to drop.
    pub exclude: String,
    /// Words 3..20 (default 5).
    pub words: u32,
    /// Word separator ("-" default).
    pub separator: String,
    /// Capitalise each word.
    pub capitalize: bool,
    /// Add one digit.
    pub include_number: bool,
}

impl Default for GeneratorOptions {
    fn default() -> Self {
        GeneratorOptions {
            mode: GeneratorMode::Random,
            length: 20,
            upper: true,
            lower: true,
            digits: true,
            symbols: true,
            min_digits: 1,
            min_symbols: 1,
            avoid_ambiguous: false,
            exclude: String::new(),
            words: 5,
            separator: "-".into(),
            capitalize: false,
            include_number: false,
        }
    }
}

/// Strength label (contract `Generated.label`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StrengthLabel {
    /// < 40 bits.
    Weak,
    /// < 60 bits.
    Fair,
    /// < 80 bits.
    Good,
    /// < 100 bits.
    Strong,
    /// 100 bits or more.
    Excellent,
}

/// A generated value (contract `Generated`). `Debug` hides the value.
#[derive(Clone, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct Generated {
    /// The value.
    pub value: String,
    /// Entropy in bits from the generator's own space (one decimal).
    pub entropy_bits: f64,
    /// Label from the bits.
    #[zeroize(skip)]
    pub label: StrengthLabel,
}

impl std::fmt::Debug for Generated {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Generated {{ value: <redacted>, entropy_bits: {}, label: {:?} }}", self.entropy_bits, self.label)
    }
}

/// Masked generator history entry (contract `GeneratedHistoryEntry`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedHistoryEntry {
    /// Entry id.
    pub id: String,
    /// When it was made.
    pub created_at: String,
    /// Length in characters.
    pub length: usize,
    /// Mode.
    pub mode: GeneratorMode,
}

/// Health check (contract `HealthCheck`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HealthCheck {
    /// Found in Pwned Passwords.
    Breached,
    /// Same password in 2+ active items that are not duplicates.
    Reused,
    /// zxcvbn 0 to 2.
    Weak,
    /// http:// URL.
    Unsecured,
    /// Unchanged for 365 days or more.
    Old,
    /// Expires soon.
    Expiring,
    /// Same username, password and site.
    Duplicate,
}

/// One finding (contract `HealthFinding`). Never holds a value or a hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthFinding {
    /// Item id.
    pub item_id: String,
    /// Check.
    pub check: HealthCheck,
    /// Plain-language detail.
    pub detail: String,
    /// Same id for items sharing one reused password (or one duplicate set).
    pub group_id: Option<String>,
}

/// Counts per check (contract `Record<HealthCheck, number>`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCounts {
    /// Breached items.
    pub breached: usize,
    /// Reused items.
    pub reused: usize,
    /// Weak items.
    pub weak: usize,
    /// Unsecured items.
    pub unsecured: usize,
    /// Old items.
    pub old: usize,
    /// Expiring items.
    pub expiring: usize,
    /// Duplicate items.
    pub duplicate: usize,
}

/// Breach check setting (contract `"off" | "manual" | "weekly"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BreachMode {
    /// Off (default).
    Off,
    /// On "Check now".
    Manual,
    /// Weekly.
    Weekly,
}

/// Health report (contract `HealthReport`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// floor(100 x healthy / total); `None` when total < 5.
    pub score: Option<u32>,
    /// Counted items.
    pub total: usize,
    /// Counted items that are not breached, reused or weak.
    pub healthy: usize,
    /// The formula in words.
    pub formula: String,
    /// Counts per check.
    pub counts: HealthCounts,
    /// Findings.
    pub findings: Vec<HealthFinding>,
    /// Active items excluded from health.
    pub excluded_count: usize,
    /// The breach-check setting.
    pub breach_check: BreachMode,
    /// When the breach check last ran.
    pub breach_checked_at: Option<String>,
}

/// One skipped import entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedItem {
    /// Title in the source.
    pub title: String,
    /// Why it was skipped.
    pub reason: String,
}

/// Import preview (contract `ImportPreview`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// Id to pass to `import_commit`.
    pub preview_id: String,
    /// Format id ("bitwarden-json", ...).
    pub format: String,
    /// Label ("Bitwarden (JSON)").
    pub format_label: String,
    /// Items that will be imported (duplicates excluded).
    pub total: usize,
    /// Counts by type of the items that will be imported.
    pub counts: std::collections::BTreeMap<ItemType, usize>,
    /// Equal to an item already in the vault; will be skipped.
    pub duplicates: usize,
    /// Skipped entries with reasons.
    pub skipped: Vec<SkippedItem>,
    /// Warnings.
    pub warnings: Vec<String>,
    /// A `.cofferx` or `.coffer` file: preview again with its password.
    pub needs_password: bool,
    /// A `.coffer` file whose key id has no stored Secret Key: preview again with it.
    pub needs_secret_key: bool,
}

/// Import result (contract `ImportResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Id of this import batch (`import_undo` takes it).
    pub batch_id: String,
    /// Items imported.
    pub imported: usize,
    /// Items skipped (duplicates and unreadable entries).
    pub skipped: usize,
    /// The tag every imported item got ("Imported/Bitwarden").
    pub tag: String,
}

/// Export kind (contract `ExportKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportKind {
    /// `.cofferx`, own password.
    CofferEncrypted,
    /// Coffer JSON (plain).
    CofferJson,
    /// Bitwarden JSON (plain).
    BitwardenJson,
    /// CSV with Bitwarden headers (logins and notes).
    Csv,
}

/// Result of `password_strength`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Strength {
    /// zxcvbn score 0 to 4.
    pub score: u8,
    /// Crack time at 10^4 guesses a second (slow hash), e.g. "3 hours".
    pub crack_time: String,
    /// zxcvbn warning, if any.
    pub warning: Option<String>,
}

/// Result of `totp_parse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpParse {
    /// Issuer from the URI.
    pub issuer: Option<String>,
    /// Account from the URI.
    pub account: Option<String>,
    /// The input makes codes.
    pub valid: bool,
}

// ---------------------------------------------------------------- stored records

/// A field as stored in the vault record. Strings are zeroed on drop.
#[derive(Clone, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct StoredField {
    /// Field id.
    pub id: String,
    /// Label.
    pub label: String,
    /// Kind.
    #[zeroize(skip)]
    pub kind: FieldKind,
    /// Plain value.
    pub value: String,
    /// Section.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    /// Built-in role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<String>,
    /// Menu choices.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

impl std::fmt::Debug for StoredField {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredField")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("kind", &self.kind)
            .field("builtin", &self.builtin)
            .finish_non_exhaustive()
    }
}

impl StoredField {
    /// A new field with a fresh id.
    pub fn new(label: &str, kind: FieldKind, value: &str, builtin: Option<&str>) -> Self {
        StoredField {
            id: Uuid::new_v4().to_string(),
            label: label.to_owned(),
            kind,
            value: value.to_owned(),
            section: None,
            builtin: builtin.map(str::to_owned),
            options: None,
        }
    }
}

/// One old password (SPEC 4: last 20).
#[derive(Clone, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct HistoryValue {
    /// Entry id.
    pub id: String,
    /// The old value.
    pub value: String,
    /// When it stopped being the password.
    pub changed_at: String,
}

/// The editable content of an item, as kept in a revision snapshot.
#[derive(Clone, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct ItemSnapshot {
    /// Type.
    #[zeroize(skip)]
    #[serde(rename = "type")]
    pub item_type: ItemType,
    /// Title.
    pub title: String,
    /// Favourite.
    pub favorite: bool,
    /// Tags.
    pub tags: Vec<String>,
    /// Fields.
    pub fields: Vec<StoredField>,
    /// Notes.
    pub notes: String,
    /// URLs.
    pub urls: Vec<ItemUrl>,
    /// Apps.
    pub apps: Vec<String>,
    /// Re-prompt.
    pub reprompt: bool,
    /// Auto-type.
    pub autotype_sequence: Option<String>,
    /// Excluded from health.
    pub health_excluded: bool,
}

/// One revision snapshot (SPEC 4: last 10).
#[derive(Clone, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct RevisionRecord {
    /// Rev of the snapshot.
    pub rev: u64,
    /// When that rev was saved.
    pub saved_at: String,
    /// The content at that rev.
    pub snapshot: ItemSnapshot,
}

/// The item record (SPEC 4): the plaintext JSON of one encrypted record.
/// Strings are zeroed on drop; `Debug` prints no value.
#[derive(Clone, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct StoredItem {
    /// Id.
    #[zeroize(skip)]
    pub id: Uuid,
    /// Type.
    #[zeroize(skip)]
    #[serde(rename = "type")]
    pub item_type: ItemType,
    /// Title.
    pub title: String,
    /// Favourite.
    pub favorite: bool,
    /// Tags.
    pub tags: Vec<String>,
    /// State.
    #[zeroize(skip)]
    pub state: ItemState,
    /// When it went to Trash.
    #[serde(default)]
    pub trashed_at: Option<String>,
    /// Creation time.
    pub created_at: String,
    /// Last update.
    pub updated_at: String,
    /// Last change of the built-in password.
    #[serde(default)]
    pub password_changed_at: Option<String>,
    /// Fields.
    pub fields: Vec<StoredField>,
    /// Notes.
    #[serde(default)]
    pub notes: String,
    /// URLs.
    #[serde(default)]
    pub urls: Vec<ItemUrl>,
    /// Apps (exe names).
    #[serde(default)]
    pub apps: Vec<String>,
    /// Re-prompt.
    #[serde(default)]
    pub reprompt: bool,
    /// Auto-type sequence.
    #[serde(default)]
    pub autotype_sequence: Option<String>,
    /// Excluded from health.
    #[serde(default)]
    pub health_excluded: bool,
    /// Old passwords, newest first (last 20).
    #[serde(default)]
    pub password_history: Vec<HistoryValue>,
    /// Revision snapshots, newest first (last 10).
    #[serde(default)]
    pub revisions: Vec<RevisionRecord>,
    /// Id of the import batch that made this item (undo by batch id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_batch: Option<String>,
}

impl std::fmt::Debug for StoredItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredItem")
            .field("id", &self.id)
            .field("type", &self.item_type)
            .field("state", &self.state)
            .field("fields", &self.fields.len())
            .finish_non_exhaustive()
    }
}

impl StoredItem {
    /// An empty item of a type with its built-in fields (empty values).
    pub fn new(item_type: ItemType, title: &str, now: &str) -> Self {
        let fields = crate::templates::template(item_type)
            .fields
            .iter()
            .map(|t| {
                let mut f = StoredField::new(t.label, t.kind, "", Some(t.role));
                f.options = crate::templates::menu_options(t.role).map(|o| o.iter().map(|s| (*s).to_owned()).collect());
                f
            })
            .collect();
        StoredItem {
            id: Uuid::new_v4(),
            item_type,
            title: title.to_owned(),
            favorite: false,
            tags: Vec::new(),
            state: ItemState::Active,
            trashed_at: None,
            created_at: now.to_owned(),
            updated_at: now.to_owned(),
            password_changed_at: None,
            fields,
            notes: String::new(),
            urls: Vec::new(),
            apps: Vec::new(),
            reprompt: false,
            autotype_sequence: None,
            health_excluded: false,
            password_history: Vec::new(),
            revisions: Vec::new(),
            import_batch: None,
        }
    }

    /// The first field with a built-in role.
    pub fn builtin(&self, role: &str) -> Option<&StoredField> {
        self.fields.iter().find(|f| f.builtin.as_deref() == Some(role))
    }

    /// Mutable first field with a built-in role.
    pub fn builtin_mut(&mut self, role: &str) -> Option<&mut StoredField> {
        self.fields.iter_mut().find(|f| f.builtin.as_deref() == Some(role))
    }

    /// The value of a built-in field, or "" when absent.
    pub fn builtin_value(&self, role: &str) -> &str {
        self.builtin(role).map(|f| f.value.as_str()).unwrap_or("")
    }

    /// Sets a built-in field's value, adding the field from the template (or
    /// as `kind`) when the item lacks it.
    pub fn set_builtin(&mut self, role: &str, kind: FieldKind, value: &str) {
        if let Some(f) = self.builtin_mut(role) {
            f.value = value.to_owned();
            return;
        }
        let label = crate::templates::template(self.item_type)
            .fields
            .iter()
            .find(|t| t.role == role)
            .map(|t| t.label)
            .unwrap_or(role);
        self.fields.push(StoredField::new(label, kind, value, Some(role)));
    }

    /// The built-in password (login, password, wifi), or "".
    pub fn password(&self) -> &str {
        self.builtin_value("password")
    }

    /// The editable content as a snapshot.
    pub fn snapshot(&self) -> ItemSnapshot {
        ItemSnapshot {
            item_type: self.item_type,
            title: self.title.clone(),
            favorite: self.favorite,
            tags: self.tags.clone(),
            fields: self.fields.clone(),
            notes: self.notes.clone(),
            urls: self.urls.clone(),
            apps: self.apps.clone(),
            reprompt: self.reprompt,
            autotype_sequence: self.autotype_sequence.clone(),
            health_excluded: self.health_excluded,
        }
    }

    /// Host of the first URL that has one.
    pub fn url_host(&self) -> Option<String> {
        self.urls.iter().find_map(|u| url_host(&u.url))
    }
}

/// The host of a URL text ("https://www.github.com/login" -> "www.github.com").
/// Accepts a bare host ("github.com/x").
pub fn url_host(url: &str) -> Option<String> {
    let u = url.trim();
    if u.is_empty() {
        return None;
    }
    let rest = match u.find("://") {
        Some(i) => &u[i + 3..],
        None => u,
    };
    let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if host_port.starts_with('[') {
        host_port.split(']').next().map(|h| format!("{h}]")).unwrap_or_default()
    } else {
        host_port.split(':').next().unwrap_or("").to_owned()
    };
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() || host.contains(' ') { None } else { Some(host) }
}

/// The URL scheme in lower case ("https"), if any.
pub fn url_scheme(url: &str) -> Option<String> {
    let u = url.trim();
    let i = u.find(':')?;
    let s = &u[..i];
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
        Some(s.to_ascii_lowercase())
    } else {
        None
    }
}

/// Vault-level secret data (SPEC 3.5 `meta` record, exactly one per vault):
/// generator history, the last generator options and the breach-check cache.
/// Health exclusions are the `health_excluded` flag of each item record
/// (SPEC 4), so they are not repeated here. The vault name is NOT here: it is
/// the file stem (SPEC 3.5).
#[derive(Clone, Default, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct MetaRecord {
    /// Creation time of the vault.
    #[serde(default)]
    pub created_at: String,
    /// Generator history, newest first (last 50).
    #[serde(default)]
    pub generator_history: Vec<GeneratedValue>,
    /// The last generator options (the tray's "Copy a new password" uses them).
    #[serde(default)]
    #[zeroize(skip)]
    pub generator_options: Option<GeneratorOptions>,
    /// Breach-check cache: one entry per item id + SHA-256 of its password.
    #[serde(default)]
    pub breach_cache: Vec<BreachCacheEntry>,
    /// When the breach check last ran.
    #[serde(default)]
    pub breach_checked_at: Option<String>,
}

impl std::fmt::Debug for MetaRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MetaRecord(<redacted>)")
    }
}

/// One generated value in the history.
#[derive(Clone, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct GeneratedValue {
    /// Entry id.
    pub id: String,
    /// The value.
    pub value: String,
    /// When it was made.
    pub created_at: String,
    /// Mode.
    #[zeroize(skip)]
    pub mode: GeneratorMode,
}

/// Breach-check result for one item and one password (SPEC 7: keyed by item
/// id + SHA-256 of the password; a new password has no entry until the
/// next check).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize)]
pub struct BreachCacheEntry {
    /// Item id.
    pub item_id: String,
    /// Hex SHA-256 of the password that was checked (inside the encrypted meta record only).
    pub password_sha256: String,
    /// Times found in Pwned Passwords (0 = not found).
    pub count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_serialise_as_contract_strings() {
        let s = serde_json::to_string(&ItemType::ALL).unwrap();
        assert_eq!(
            s,
            r#"["login","password","note","card","identity","bank","document","sshKey","apiCredential","wifi","license"]"#
        );
        assert_eq!(serde_json::to_string(&FieldKind::MonthYear).unwrap(), r#""monthYear""#);
        assert_eq!(serde_json::to_string(&FieldKind::CardNumber).unwrap(), r#""cardNumber""#);
        assert_eq!(serde_json::to_string(&ExportKind::CofferEncrypted).unwrap(), r#""cofferEncrypted""#);
        assert_eq!(serde_json::to_string(&StrengthLabel::Excellent).unwrap(), r#""excellent""#);
    }

    #[test]
    fn summary_shape_is_camel_case() {
        let s = ItemSummary {
            id: "x".into(),
            item_type: ItemType::SshKey,
            title: "t".into(),
            subtitle: "".into(),
            favorite: false,
            tags: vec![],
            state: ItemState::Active,
            updated_at: "u".into(),
            last_used_at: None,
            url_host: None,
            has_totp: false,
            flags: ItemFlags::default(),
        };
        let v: serde_json::Value = serde_json::to_value(&s).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        for k in ["id", "type", "title", "subtitle", "favorite", "tags", "state", "updatedAt", "lastUsedAt", "urlHost", "hasTotp", "flags"] {
            assert!(keys.contains(&k), "missing {k}");
        }
        assert_eq!(v["type"], "sshKey");
    }

    #[test]
    fn item_input_value_null_means_keep() {
        let j = r#"{"type":"login","title":"t","favorite":false,"tags":[],"fields":[{"id":"a","label":"Password","kind":"concealed","value":null,"builtin":"password"}],"notes":"","urls":[],"apps":[],"reprompt":false,"autotypeSequence":null,"healthExcluded":false}"#;
        let i: ItemInput = serde_json::from_str(j).unwrap();
        assert_eq!(i.fields[0].value, None);
        assert_eq!(i.id, None);
    }

    #[test]
    fn hosts() {
        assert_eq!(url_host("https://www.GitHub.com/login?x=1").as_deref(), Some("www.github.com"));
        assert_eq!(url_host("github.com").as_deref(), Some("github.com"));
        assert_eq!(url_host("http://user:pw@host:8080/p").as_deref(), Some("host"));
        assert_eq!(url_host("").as_deref(), None);
        assert_eq!(url_scheme("HTTPS://x").as_deref(), Some("https"));
        assert_eq!(url_scheme("file:///c:/x").as_deref(), Some("file"));
    }
}
