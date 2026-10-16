// DEMO DATA. Every person, email and secret here is made up: emails use the
// reserved example domains, cards are the public test numbers, keys say DEMO.
// Dates are relative to "now", so the health findings stay true on any day.
import { BUILTIN_FIELDS, MENU_OPTIONS } from "../contract";
import type { Field, FieldKind, ItemState, ItemType } from "../contract";
import type { ItemContent, StoredHistoryEntry, StoredItem } from "./model";
import { contentOf } from "./model";
import { stableId } from "./random";

const DAY = 86_400_000;
const MIN = 60_000;

export const DEMO_VAULT_NAME = "Personal";
export const DEMO_VAULT_PATH = "C:\\Users\\alex\\Coffer\\Personal.coffer";
export const DEMO_MASTER_PASSWORD = "demo";

/** Shared with the fake import file, so its duplicates match real vault items. */
export const DEMO_LOGINS = {
  github: { username: "alex@example.com", password: "vT8#qLm2!xWp9@Rz4kNe", url: "https://github.com/login" },
  netflix: { username: "alex@example.com", password: "Lantern-Coffee-1987", url: "https://www.netflix.com/login" },
};

/** The one password shared by Amazon, Netflix and Spotify (Reused). */
const REUSED = DEMO_LOGINS.netflix.password;

export const DEMO_TOTP = {
  github: "otpauth://totp/GitHub:alex-morgan?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
  google: "otpauth://totp/Google:alex.morgan%40example.net?secret=KRUGKIDROVUWG2ZAMJZG653OEBTG66BAJZ2W24DT&issuer=Google",
  slack: "otpauth://totp/Slack:alex%40work.example?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Slack&digits=6&period=30",
  steam: "steam://MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U",
  aws: "otpauth://totp/Amazon%20Web%20Services:alex.admin?secret=ONSWG4TFOQQGC3TEEBWW65LTMUQGM33SEBSGK3LP&issuer=Amazon%20Web%20Services&algorithm=SHA1&digits=6",
};

interface CustomSpec {
  label: string;
  kind: FieldKind;
  value: string;
  section?: string;
}

interface Spec {
  key: string;
  type: ItemType;
  title: string;
  /** Built-in role -> value. Only roles with a value become fields. */
  values: Record<string, string>;
  custom?: CustomSpec[];
  notes?: string;
  urls?: string[];
  apps?: string[];
  tags: string[];
  favorite?: boolean;
  state?: ItemState;
  trashedDaysAgo?: number;
  createdDaysAgo: number;
  updatedDaysAgo: number;
  /** Days since the built-in password changed; null = unknown. Defaults to updatedDaysAgo when a password exists. */
  pwChangedDaysAgo?: number | null;
  lastUsedMinutesAgo?: number;
  reprompt?: boolean;
  healthExcluded?: boolean;
  /** Old passwords, newest first: [value, days ago it was replaced]. */
  history?: Array<[string, number]>;
}

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const ym = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

function specs(now: number): Spec[] {
  const ahead = (days: number) => now + days * DAY;
  return [
    // ----- logins -----
    {
      key: "github",
      type: "login",
      title: "GitHub",
      values: { username: DEMO_LOGINS.github.username, password: DEMO_LOGINS.github.password, totp: DEMO_TOTP.github },
      custom: [{ label: "Recovery codes", kind: "concealed", value: "a7f3-92kd 4m8q-x2pz 7hc4-vb91 q2w8-n5ty", section: "Recovery" }],
      urls: [DEMO_LOGINS.github.url],
      tags: ["Dev", "Work"],
      favorite: true,
      createdDaysAgo: 900,
      updatedDaysAgo: 40,
      pwChangedDaysAgo: 40,
      lastUsedMinutesAgo: 120,
      history: [
        ["Gh!Spring-Oak-2025", 40],
        ["r3d-Kite-Harbor-19", 210],
        ["github2023!", 400],
      ],
    },
    {
      key: "google",
      type: "login",
      title: "Google",
      values: { username: "alex.morgan@example.net", password: "Wq4!nB8z#Tc2LmP6sYv0", totp: DEMO_TOTP.google },
      urls: ["https://accounts.google.com"],
      tags: ["Personal"],
      favorite: true,
      createdDaysAgo: 1400,
      updatedDaysAgo: 120,
      lastUsedMinutesAgo: 26 * 60,
    },
    {
      key: "amazon",
      type: "login",
      title: "Amazon",
      values: { username: "alex@example.com", password: REUSED },
      urls: ["https://www.amazon.com"],
      tags: ["Personal", "Finance"],
      createdDaysAgo: 1100,
      updatedDaysAgo: 300,
      lastUsedMinutesAgo: 5 * 24 * 60,
    },
    {
      key: "netflix",
      type: "login",
      title: "Netflix",
      values: { username: DEMO_LOGINS.netflix.username, password: REUSED },
      urls: [DEMO_LOGINS.netflix.url],
      tags: ["Personal"],
      createdDaysAgo: 800,
      updatedDaysAgo: 300,
      lastUsedMinutesAgo: 2 * 24 * 60,
    },
    {
      key: "spotify",
      type: "login",
      title: "Spotify",
      values: { username: "alex@example.com", password: REUSED },
      urls: ["https://accounts.spotify.com"],
      tags: ["Personal"],
      createdDaysAgo: 700,
      updatedDaysAgo: 280,
    },
    {
      key: "slack",
      type: "login",
      title: "Slack",
      values: { username: "alex@work.example", password: "jH6$eR1x!Kd9Wm3^Qp7v", totp: DEMO_TOTP.slack },
      urls: ["https://slack.com/signin"],
      apps: ["slack.exe"],
      tags: ["Work"],
      favorite: true,
      createdDaysAgo: 500,
      updatedDaysAgo: 90,
      lastUsedMinutesAgo: 20,
    },
    {
      key: "figma",
      type: "login",
      title: "Figma",
      values: { username: "alex@work.example", password: "figma2020" },
      urls: ["https://www.figma.com/login"],
      apps: ["figma.exe"],
      tags: ["Work/Clients"],
      createdDaysAgo: 650,
      updatedDaysAgo: 200,
    },
    {
      key: "dropbox",
      type: "login",
      title: "Dropbox",
      values: { username: "alex@example.com", password: "Dropbox123!" },
      urls: ["https://www.dropbox.com/login"],
      apps: ["dropbox.exe"],
      tags: ["Personal"],
      createdDaysAgo: 1200,
      updatedDaysAgo: 150,
    },
    {
      key: "steam",
      type: "login",
      title: "Steam",
      values: { username: "alexmorgan_gg", password: "Mx7&vK2#pL9!wQ4zR8tB", totp: DEMO_TOTP.steam },
      urls: ["https://store.steampowered.com/login"],
      apps: ["steam.exe"],
      tags: ["Personal"],
      createdDaysAgo: 1500,
      updatedDaysAgo: 75,
      lastUsedMinutesAgo: 30 * 60,
    },
    {
      key: "aws",
      type: "login",
      title: "AWS Console",
      values: { username: "alex.admin", password: "N3v@Tq8!Zk5#Hw2^Lc9x", totp: DEMO_TOTP.aws },
      custom: [
        { label: "Account ID", kind: "text", value: "123456789012", section: "Account" },
        { label: "Region", kind: "text", value: "eu-west-2", section: "Account" },
      ],
      urls: ["https://signin.aws.amazon.com/console"],
      tags: ["Dev", "Work"],
      createdDaysAgo: 420,
      updatedDaysAgo: 30,
      lastUsedMinutesAgo: 3 * 60,
    },
    {
      key: "stripe",
      type: "login",
      title: "Stripe Dashboard",
      values: { username: "alex@work.example", password: "Bq5!Xr8#Mz2@Tn6$Kw4p" },
      urls: ["https://dashboard.stripe.com/login"],
      tags: ["Work/Clients", "Finance"],
      createdDaysAgo: 900,
      updatedDaysAgo: 520,
      pwChangedDaysAgo: 520,
    },
    {
      key: "router",
      type: "login",
      title: "Home router",
      values: { username: "admin", password: "Purple-Kettle-Orbit-42" },
      urls: ["http://192.168.1.1"],
      tags: ["Home"],
      createdDaysAgo: 600,
      updatedDaysAgo: 90,
    },
    {
      key: "forum",
      type: "login",
      title: "Retro Computing Forum",
      values: { username: "alexm", password: "Blue-Harbour-73!" },
      urls: ["http://forum.example.org/login"],
      tags: ["Personal"],
      createdDaysAgo: 2000,
      updatedDaysAgo: 700,
      pwChangedDaysAgo: null,
    },
    {
      key: "linkedin",
      type: "login",
      title: "LinkedIn",
      values: { username: "alex@example.com", password: "Q7v!mR2#sLx9pT4wZ6c" },
      urls: ["https://www.linkedin.com/login"],
      tags: ["Work"],
      createdDaysAgo: 365,
      updatedDaysAgo: 60,
    },
    {
      key: "linkedin-old",
      type: "login",
      title: "LinkedIn (old entry)",
      values: { username: "alex@example.com", password: "Q7v!mR2#sLx9pT4wZ6c" },
      urls: ["https://www.linkedin.com"],
      tags: ["Work"],
      createdDaysAgo: 1300,
      updatedDaysAgo: 60,
      pwChangedDaysAgo: null,
    },
    {
      key: "atlassian",
      type: "login",
      title: "Atlassian (Northwind)",
      values: { username: "alex@work.example", password: "Fz8^Rw3!Lp6#Yb1@Nq5m" },
      urls: ["https://id.atlassian.com/login"],
      tags: ["Work/Clients"],
      createdDaysAgo: 240,
      updatedDaysAgo: 100,
    },
    {
      key: "microsoft",
      type: "login",
      title: "Microsoft account",
      values: { username: "alex.morgan@example.net", password: "Hk2@Vn7!Pq4#Ws9$Jx3z" },
      urls: ["https://login.live.com"],
      tags: ["Personal"],
      createdDaysAgo: 1600,
      updatedDaysAgo: 180,
    },
    {
      key: "staging",
      type: "login",
      title: "Staging test account",
      values: { username: "tester", password: "test1234" },
      urls: ["http://localhost:3000/login"],
      notes: "Shared test login for the local staging build. Not a real account.",
      tags: ["Dev"],
      createdDaysAgo: 120,
      updatedDaysAgo: 120,
      healthExcluded: true,
    },
    // ----- passwords -----
    {
      key: "bios",
      type: "password",
      title: "Laptop BIOS",
      values: { password: "Granite-Swallow-Mosaic-8" },
      notes: "Supervisor password for the ThinkPad firmware.",
      tags: ["Home"],
      createdDaysAgo: 400,
      updatedDaysAgo: 400,
      pwChangedDaysAgo: 200,
    },
    {
      key: "backup",
      type: "password",
      title: "Backup drive encryption",
      values: { password: "Velvet!Thunder-Canyon-55" },
      tags: ["Home", "Dev"],
      createdDaysAgo: 300,
      updatedDaysAgo: 300,
      pwChangedDaysAgo: 300,
    },
    // ----- notes -----
    {
      key: "server-notes",
      type: "note",
      title: "Home server notes",
      values: {},
      notes: [
        "# Home server",
        "",
        "Notes for the **NAS** in the hall cupboard. See the [Synology docs](https://kb.synology.com).",
        "",
        "- Model: Synology DS220+",
        "- Address: `192.168.1.20`",
        "- Admin user: `alex`",
        "",
        "## Restart",
        "",
        "1. Stop the *nightly* backup job",
        "2. Run `sudo systemctl restart smbd`",
        "3. Check the **Shares** page",
      ].join("\n"),
      tags: ["Dev", "Home"],
      createdDaysAgo: 210,
      updatedDaysAgo: 12,
    },
    {
      key: "alarm",
      type: "note",
      title: "House alarm",
      values: {},
      notes: "Panel is behind the front door. Code below; the installer code is in the manual.",
      custom: [{ label: "Alarm code", kind: "pin", value: "4815" }],
      tags: ["Home"],
      createdDaysAgo: 330,
      updatedDaysAgo: 330,
    },
    // ----- cards -----
    {
      key: "visa",
      type: "card",
      title: "Visa Debit",
      values: { cardholder: "Alex Morgan", number: "4242424242424242", expiry: ym(ahead(25)), cvv: "123", brand: "Visa" },
      tags: ["Finance"],
      favorite: true,
      createdDaysAgo: 1000,
      updatedDaysAgo: 1000,
      lastUsedMinutesAgo: 3 * 24 * 60,
    },
    {
      key: "mastercard",
      type: "card",
      title: "Mastercard Credit",
      values: { cardholder: "Alex Morgan", number: "5555555555554444", expiry: ym(ahead(3 * 365)), cvv: "321", pin: "8024", brand: "Mastercard" },
      tags: ["Finance"],
      createdDaysAgo: 200,
      updatedDaysAgo: 200,
    },
    // ----- identity -----
    {
      key: "identity",
      type: "identity",
      title: "Alex Morgan",
      values: {
        title: "Mx",
        firstName: "Alex",
        lastName: "Morgan",
        birthDate: "1990-04-12",
        email: "alex@example.com",
        phone: "+44 7700 900123",
        address1: "12 Example Road",
        city: "Bristol",
        postcode: "AB1 2CD",
        country: "United Kingdom",
        company: "Example Ltd",
      },
      custom: [{ label: "National Insurance number", kind: "text", value: "QQ 12 34 56 C", section: "Other" }],
      tags: ["Personal"],
      createdDaysAgo: 1400,
      updatedDaysAgo: 90,
    },
    // ----- bank (re-prompt) -----
    {
      key: "bank",
      type: "bank",
      title: "Northbank Current Account",
      values: {
        bankName: "Northbank",
        holder: "Alex Morgan",
        accountNumber: "41926583",
        sortCode: "00-11-22",
        iban: "GB33BUKB20201555555555",
        swift: "NBNKGB2L",
        pin: "4321",
      },
      custom: [
        { label: "Customer number", kind: "text", value: "1029384756", section: "Online banking" },
        { label: "Passcode", kind: "pin", value: "602413", section: "Online banking" },
      ],
      tags: ["Finance"],
      favorite: true,
      reprompt: true,
      createdDaysAgo: 1700,
      updatedDaysAgo: 60,
    },
    // ----- documents -----
    {
      key: "passport",
      type: "document",
      title: "Passport",
      values: {
        docKind: "Passport",
        number: "999228775",
        fullName: "Alex Morgan",
        issued: ymd(ahead(240 - 10 * 365)),
        expires: ymd(ahead(240)),
        country: "United Kingdom",
      },
      tags: ["Personal"],
      createdDaysAgo: 1000,
      updatedDaysAgo: 1000,
    },
    {
      key: "licence",
      type: "document",
      title: "Driving licence",
      values: {
        docKind: "Driving licence",
        number: "MORGA904120AM9XX",
        fullName: "Alex Morgan",
        issued: ymd(ahead(-4 * 365)),
        expires: ymd(ahead(6 * 365)),
        country: "United Kingdom",
      },
      tags: ["Personal"],
      createdDaysAgo: 900,
      updatedDaysAgo: 900,
    },
    // ----- SSH key -----
    {
      key: "ssh",
      type: "sshKey",
      title: "GitHub deploy key",
      values: {
        // Not a key and not in PEM form (so secret scanners stay quiet): demo text only.
        privateKey: [
          "----- DEMO SSH KEY (NOT A REAL KEY) -----",
          "DEMOONLYb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAA",
          "AAtzc2gtZWQyNTUxOQAAACDEMOONLYDEMOONLYDEMOONLYDEMOONLYDEMOONLYDEMO==",
          "----- END DEMO SSH KEY -----",
        ].join("\n"),
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDEMOONLYDEMOONLYDEMOONLYDEMOONLYDEMOONLY alex@DEMO-PC",
        fingerprint: "SHA256:dEm0OnLyN0tAR3alK3yDem0OnLyN0tAR3alK3yQ",
        passphrase: "Cobalt-Meadow-Lantern-17",
      },
      tags: ["Dev"],
      createdDaysAgo: 150,
      updatedDaysAgo: 150,
    },
    // ----- API credentials -----
    {
      key: "stripe-api",
      type: "apiCredential",
      title: "Stripe API key (test mode)",
      values: {
        username: "acct_demo_northwind",
        credential: "demo-key-7f3c9a1e5b2d4f60a8c1e9b7d3f5a2c4",
        host: "https://api.stripe.com",
        expires: ymd(ahead(45)),
      },
      notes: "Restricted key for the Northwind checkout. Rotate before it expires.",
      tags: ["Dev", "Work/Clients"],
      createdDaysAgo: 320,
      updatedDaysAgo: 45,
    },
    {
      key: "metoffice",
      type: "apiCredential",
      title: "Met Office DataHub",
      values: {
        username: "alex@example.com",
        credential: "demo-key-1b6e0d9c4a7f2e5b8c3d6a9f0e1b4c7d",
        host: "https://data.hub.api.metoffice.gov.uk",
        expires: ymd(ahead(400)),
      },
      tags: ["Dev"],
      createdDaysAgo: 90,
      updatedDaysAgo: 90,
    },
    // ----- Wi-Fi -----
    {
      key: "wifi",
      type: "wifi",
      title: "Home Wi-Fi",
      values: { ssid: "Morgan-Home-5G", password: "Orchid-Lantern-Parade-61", security: "WPA3" },
      tags: ["Home"],
      favorite: true,
      createdDaysAgo: 600,
      updatedDaysAgo: 600,
      lastUsedMinutesAgo: 10 * 24 * 60,
    },
    // ----- licence -----
    {
      key: "jetbrains",
      type: "license",
      title: "JetBrains All Products Pack",
      values: {
        product: "All Products Pack",
        version: "2026.2",
        licenseKey: "DEMO-7Q4K-2M9X-JB26-DEMO",
        licensedTo: "Alex Morgan",
        email: "alex@example.com",
        purchaseDate: ymd(ahead(-200)),
      },
      tags: ["Dev"],
      createdDaysAgo: 200,
      updatedDaysAgo: 200,
    },
    // ----- archived -----
    {
      key: "yahoo",
      type: "login",
      title: "Yahoo Mail",
      values: { username: "alex.morgan@example.net", password: "Sunflower88" },
      urls: ["https://login.yahoo.com"],
      tags: ["Personal"],
      state: "archived",
      createdDaysAgo: 3000,
      updatedDaysAgo: 400,
    },
    {
      key: "flat-wifi",
      type: "wifi",
      title: "Flat Wi-Fi (old)",
      values: { ssid: "Flat-3B", password: "kettle-biscuit-77", security: "WPA2" },
      tags: ["Home"],
      state: "archived",
      createdDaysAgo: 1500,
      updatedDaysAgo: 700,
    },
    // ----- trashed (within the 30 days) -----
    {
      key: "dribbble",
      type: "login",
      title: "Dribbble",
      values: { username: "alex@example.com", password: "Pink-Comet-Studio-3" },
      urls: ["https://dribbble.com/session/new"],
      tags: ["Work"],
      state: "trashed",
      trashedDaysAgo: 5,
      createdDaysAgo: 800,
      updatedDaysAgo: 5,
    },
    {
      key: "old-codes",
      type: "note",
      title: "Old recovery codes",
      values: {},
      notes: "Replaced in the spring. Safe to delete.",
      tags: ["Personal"],
      state: "trashed",
      trashedDaysAgo: 12,
      createdDaysAgo: 500,
      updatedDaysAgo: 12,
    },
  ];
}

const iso = (ms: number): string => new Date(ms).toISOString();

function buildFields(spec: Spec): Field[] {
  const fields: Field[] = [];
  // Built-in fields from the contract table (only those with a value); ids are UUID-shaped.
  for (const def of BUILTIN_FIELDS[spec.type]) {
    const value = spec.values[def.role];
    if (value === undefined || value === "") continue;
    const options = def.kind === "menu" && MENU_OPTIONS[def.role] ? [...MENU_OPTIONS[def.role]] : undefined;
    fields.push({ id: stableId(`${spec.key}/${def.role}`), label: def.label, kind: def.kind, value, section: null, builtin: def.role, options });
  }
  for (const c of spec.custom ?? []) {
    fields.push({ id: stableId(`${spec.key}/${c.label}`), label: c.label, kind: c.kind, value: c.value, section: c.section ?? null, builtin: null });
  }
  return fields;
}

function build(spec: Spec, now: number): StoredItem {
  const fields = buildFields(spec);
  const hasPassword = !!spec.values.password;
  const history: StoredHistoryEntry[] = (spec.history ?? []).map(([value, days], n) => ({
    id: stableId(`${spec.key}/history/${n}`),
    value,
    changedAt: iso(now - days * DAY - 3 * 60 * MIN),
  }));
  const pwDays = spec.pwChangedDaysAgo === undefined ? spec.updatedDaysAgo : spec.pwChangedDaysAgo;
  const updatedAt = iso(now - spec.updatedDaysAgo * DAY - 47 * MIN);
  const content: ItemContent = {
    type: spec.type,
    title: spec.title,
    favorite: !!spec.favorite,
    tags: [...spec.tags],
    fields,
    notes: spec.notes ?? "",
    urls: (spec.urls ?? []).map((url) => ({ url, label: null })),
    apps: spec.apps ?? [],
    reprompt: !!spec.reprompt,
    autotypeSequence: null,
    healthExcluded: !!spec.healthExcluded,
  };
  // Earlier versions differ only in the password, one per history entry (oldest first).
  const revisions = history
    .slice()
    .reverse()
    .map((h, n) => {
      const snap = contentOf(content);
      const pw = snap.fields.find((f) => f.builtin === "password");
      if (pw) pw.value = h.value;
      return { rev: n + 1, savedAt: iso(Date.parse(h.changedAt) - 30 * DAY), snapshot: snap };
    });
  return {
    ...content,
    id: stableId(spec.key),
    rev: revisions.length + 1 + (spec.updatedDaysAgo > 100 ? 1 : 2),
    state: spec.state ?? "active",
    createdAt: iso(now - spec.createdDaysAgo * DAY - 5 * 60 * MIN),
    updatedAt,
    trashedAt: spec.trashedDaysAgo !== undefined ? iso(now - spec.trashedDaysAgo * DAY) : null,
    passwordChangedAt: hasPassword && pwDays !== null ? iso(now - pwDays * DAY - 47 * MIN) : null,
    attachments: [],
    passwordHistory: history,
    revisions,
    lastUsedAt: spec.lastUsedMinutesAgo !== undefined ? iso(now - spec.lastUsedMinutesAgo * MIN) : null,
  };
}

/** The demo vault's items, dated relative to `now`. */
export function seedItems(now: number): StoredItem[] {
  return specs(now).map((s) => build(s, now));
}

/** The GitHub login's id (Quick Access suggests it for the demo Chrome window). */
export const GITHUB_ID = stableId("github");
