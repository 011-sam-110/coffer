"""Builds the two ZIP fixtures (1PUX and Dashlane CSV ZIP) from hand-written,
synthetic content, following docs/research/import-formats.md. Fixed ZIP
timestamps keep the bytes stable."""
import json
import sys
import zipfile

out = sys.argv[1]
TS = (2026, 1, 1, 0, 0, 0)


def add(z, name, text):
    info = zipfile.ZipInfo(name, date_time=TS)
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, text.encode("utf-8"))


attributes = {"version": 3, "description": "1Password Unencrypted Export", "createdAt": 1767225600}
data = {
    "accounts": [
        {
            "attrs": {"accountName": "Synthetic", "name": "Synthetic Person", "avatar": "", "email": "synthetic@example.com",
                      "uuid": "SYNTHETICACCOUNT0000000000", "domain": "https://synthetic.example/"},
            "vaults": [
                {
                    "attrs": {"uuid": "vaultuuid0001", "desc": "", "avatar": "", "name": "Private", "type": "P"},
                    "items": [
                        {
                            "uuid": "item0001", "favIndex": 1, "createdAt": 1700000000, "updatedAt": 1700001000,
                            "state": "active", "categoryUuid": "001",
                            "overview": {"title": "Synthetic 1P Login", "subtitle": "liam", "url": "https://one.example.com",
                                         "urls": [{"label": "", "url": "https://one.example.com"}], "tags": ["Travel"]},
                            "details": {
                                "loginFields": [
                                    {"value": "liam", "id": "", "name": "username", "fieldType": "T", "designation": "username"},
                                    {"value": "OnePux-Login-1!", "id": "", "name": "password", "fieldType": "P", "designation": "password"},
                                ],
                                "notesPlain": "Synthetic 1PUX note",
                                "sections": [
                                    {"title": "Extra", "name": "extra", "fields": [
                                        {"title": "one-time password", "id": "TOTP_1", "value": {"totp": "otpauth://totp/One:liam?secret=GEZDGNBVGY3TQOJQ"}},
                                        {"title": "recovery code", "id": "rc", "value": {"concealed": "OnePux-Recovery-1"}},
                                        {"title": "member since", "id": "since", "value": {"date": 1600000000}},
                                    ]}
                                ],
                                "passwordHistory": [{"value": "OnePux-Old-1!", "time": 1690000000}],
                            },
                        },
                        {
                            "uuid": "item0002", "favIndex": 0, "createdAt": 1700000000, "updatedAt": 1700000000,
                            "state": "archived", "categoryUuid": "002",
                            "overview": {"title": "Synthetic 1P Card", "subtitle": "", "tags": []},
                            "details": {"loginFields": [], "notesPlain": "", "sections": [
                                {"title": "", "name": "", "fields": [
                                    {"title": "cardholder name", "id": "cardholder", "value": {"string": "Liam Example"}},
                                    {"title": "type", "id": "type", "value": {"creditCardType": "mc"}},
                                    {"title": "number", "id": "ccnum", "value": {"creditCardNumber": "5555555555554444"}},
                                    {"title": "verification number", "id": "cvv", "value": {"concealed": "321"}},
                                    {"title": "expiry date", "id": "expiry", "value": {"monthYear": 202812}},
                                ]}
                            ], "passwordHistory": []},
                        },
                        {
                            "uuid": "item0003", "favIndex": 0, "createdAt": 1700000000, "updatedAt": 1700000000,
                            "state": "active", "categoryUuid": "005",
                            "overview": {"title": "Synthetic 1P Password", "tags": []},
                            "details": {"loginFields": [], "notesPlain": "", "sections": [], "password": "OnePux-Password-1!", "passwordHistory": []},
                        },
                        {
                            "uuid": "item0004", "favIndex": 0, "createdAt": 1700000000, "updatedAt": 1700000000,
                            "state": "active", "categoryUuid": "109",
                            "overview": {"title": "Synthetic Home Wi-Fi", "tags": []},
                            "details": {"loginFields": [], "notesPlain": "", "sections": [
                                {"title": "", "name": "", "fields": [
                                    {"title": "network name", "id": "network_name", "value": {"string": "SyntheticNet"}},
                                    {"title": "wireless network password", "id": "wireless_password", "value": {"concealed": "OnePux-Wifi-1!"}},
                                    {"title": "wireless security", "id": "wireless_security", "value": {"menu": "wpa2p"}},
                                ]}
                            ], "passwordHistory": []},
                        },
                        {
                            "uuid": "item0005", "favIndex": 0, "createdAt": 1700000000, "updatedAt": 1700000000,
                            "state": "active", "categoryUuid": "106",
                            "overview": {"title": "Synthetic Passport", "tags": []},
                            "details": {"loginFields": [], "notesPlain": "", "sections": [
                                {"title": "", "name": "", "fields": [
                                    {"title": "number", "id": "number", "value": {"string": "P0000000"}},
                                    {"title": "full name", "id": "fullname", "value": {"string": "Liam Example"}},
                                    {"title": "expiry date", "id": "expiry_date", "value": {"date": 1893456000}},
                                    {"title": "address", "id": "addr", "value": {"address": {"street": "1 Test Street", "city": "Testville", "country": "gb", "zip": "TE1 1ST", "state": ""}}},
                                ]}
                            ], "passwordHistory": []},
                        },
                    ],
                },
                {
                    "attrs": {"uuid": "vaultuuid0002", "desc": "", "avatar": "", "name": "Shared", "type": "U"},
                    "items": [
                        {
                            "uuid": "item0006", "favIndex": 0, "createdAt": 1700000000, "updatedAt": 1700000000,
                            "state": "active", "categoryUuid": "003",
                            "overview": {"title": "Synthetic Shared Note", "tags": []},
                            "details": {"loginFields": [], "notesPlain": "Shared synthetic note body", "sections": [], "passwordHistory": []},
                        },
                        {
                            "uuid": "item0007", "favIndex": 0, "createdAt": 1700000000, "updatedAt": 1700000000,
                            "state": "active", "categoryUuid": "006",
                            "overview": {"title": "Synthetic Document", "tags": []},
                            "details": {"loginFields": [], "notesPlain": "", "sections": [], "passwordHistory": [],
                                        "documentAttributes": {"fileName": "scan.pdf", "documentId": "doc1", "decryptedSize": 10}},
                        },
                    ],
                },
            ],
        }
    ]
}

with zipfile.ZipFile(out + "/synthetic-1password.1pux", "w") as z:
    add(z, "export.attributes", json.dumps(attributes, indent=2))
    add(z, "export.data", json.dumps(data, indent=2))
    add(z, "files/doc1__scan.pdf", "synthetic file body")

credentials = (
    "username,username2,username3,title,password,note,url,category,otpSecret,otpUrl\n"
    "mia@example.com,mia2,,Synthetic Mail,Dashlane-Zip-1!,first note,https://mail.example.org,Personal,,\n"
    "noah,,,Synthetic Shop,Dashlane-Zip-2!,,https://shop.example.org,,,otpauth://totp/Shop:noah?secret=GEZDGNBVGY3TQOJQ\n"
)
securenotes = "title,note\nSynthetic Dashlane Note,\"Two lines,\nwith a comma\"\n"
payments = (
    "type,account_name,account_holder,cc_number,code,expiration_month,expiration_year,routing_number,account_number,country,issuing_bank\n"
    "credit_card,Synthetic Visa,Mia Example,4000000000000002,456,03,2030,,,GB,Example Bank\n"
    "bank,Synthetic Current,Mia Example,,,,,00-00-00,00000000,GB,Example Bank\n"
)
ids = (
    "type,number,name,issue_date,expiration_date,place_of_issue,state\n"
    "passport,D0000000,Mia Example,2020-01-01,2030-01-01,GB,\n"
    "license,L0000000,Mia Example,2019-01-01,2029-01-01,GB,\n"
)
personal = (
    "type,title,first_name,middle_name,last_name,login,date_of_birth,place_of_birth,email,email_type,item_name,phone_number,address,country,state,city,zip,address_recipient,address_building,address_apartment,address_floor,address_door_code,job_title,url\n"
    "name,Ms,Mia,,Example,,1990-01-01,Testville,,,,,,,,,,,,,,,,\n"
    "email,,,,,,,,mia@example.com,personal,Personal email,,,,,,,,,,,,,\n"
)
with zipfile.ZipFile(out + "/synthetic-dashlane.zip", "w") as z:
    add(z, "credentials.csv", credentials)
    add(z, "securenotes.csv", securenotes)
    add(z, "payments.csv", payments)
    add(z, "ids.csv", ids)
    add(z, "personalInfo.csv", personal)
print("ok")
