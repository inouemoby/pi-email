# pi-email

Email reading extension for [pi coding agent](https://github.com/earendil-works/pi-mono). Reads emails via IMAP with three auth modes: basic password, OAuth2 interactive (browser popup), and OAuth2 headless (fully automatic).

## Install

```bash
pi install git:github.com/inouemoby/pi-email
```

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Chrome](https://www.google.com/chrome/) installed at default path (headless OAuth2 accounts only)

## Configure

Add accounts to `~/.pi/agent/settings.json` under the `"pi-email"` field.

### Basic auth (QQ Mail, 163, 126, etc.)

Accounts that use authorization codes or app-specific passwords.

```json
{
  "pi-email": {
    "accounts": [
      {
        "name": "QQ Mail",
        "imap": { "host": "imap.qq.com", "port": 993 },
        "user": "xxx@qq.com",
        "pass": "authorization-code"
      }
    ]
  }
}
```

| Provider | IMAP Server | Port | Auth |
|----------|-------------|------|------|
| QQ Mail | imap.qq.com | 993 | Authorization code |
| 163 Mail | imap.163.com | 993 | Authorization code |
| 126 Mail | imap.126.com | 993 | Authorization code |

### OAuth2 interactive (Outlook.com, Gmail)

For personal Microsoft accounts (`@outlook.com` / `@hotmail.com`) and Google accounts (`@gmail.com`). On first use, a browser window opens for the user to manually log in (passkeys/MFA supported). After that, tokens refresh automatically — no repeated login.

**Personal Outlook.com / Hotmail:**

```json
{
  "name": "Outlook",
  "imap": { "host": "outlook.office365.com", "port": 993 },
  "user": "xxx@outlook.com",
  "auth_type": "oauth2",
  "oauth2": {
    "provider": "microsoft",
    "client_id": "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
    "authority": "https://login.microsoftonline.com/common",
    "scopes": [
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "https://outlook.office.com/SMTP.Send",
      "offline_access"
    ],
    "redirect_uri": "http://localhost:8401/"
  }
}
```

**Gmail:**

```json
{
  "name": "Gmail",
  "imap": { "host": "imap.gmail.com", "port": 993 },
  "user": "xxx@gmail.com",
  "auth_type": "oauth2",
  "oauth2": {
    "provider": "google",
    "client_id": "406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com",
    "client_secret": "kSmqreRr0qwBWJgbf5Y-PjSU",
    "authority": "https://accounts.google.com",
    "scopes": ["https://mail.google.com/"],
    "redirect_uri": "http://localhost:8401/"
  }
}
```

Notes:
- Outlook scope uses `outlook.office.com` (not `outlook.office365.com`)
- Outlook authority uses `common`
- No `pass` or `login_user` needed — these go through browser-based authorization
- Client IDs are Thunderbird's public client IDs

### OAuth2 headless (Office 365 school / corporate with federated login)

For Office 365 accounts behind federated SAML authentication (e.g. Keycloak). The plugin launches headless Chrome and completes the entire login chain automatically — no user interaction needed.

```json
{
  "name": "School Mail",
  "imap": { "host": "outlook.office365.com", "port": 993 },
  "user": "user@school.example.jp",
  "pass": "school-idp-password",
  "auth_type": "oauth2",
  "login_user": "school-username",
  "oauth2": {
    "provider": "microsoft",
    "client_id": "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
    "authority": "https://login.microsoftonline.com/organizations",
    "scopes": [
      "https://outlook.office365.com/IMAP.AccessAsUser.All",
      "https://outlook.office365.com/SMTP.Send",
      "offline_access"
    ],
    "redirect_uri": "http://localhost:8401/"
  }
}
```

| Field | Description |
|-------|-------------|
| `user` | Email address for IMAP/SMTP auth |
| `pass` | Password for the school IdP login |
| `login_user` | Username for the school login form (if different from email prefix) |

Requirements:
- Chrome installed at `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Account must NOT have MFA (TOTP, Authenticator, etc.)

## Tools

| Tool | Description |
|------|-------------|
| `email_list` | List or search emails. Supports filtering by unread, sender, subject, body, date range. |
| `email_read` | Read full email content by sequence number. |
| `email_folders` | List all mail folders/labels. |

### email_list

```json
{
  "account": "School Mail",
  "folder": "INBOX",
  "limit": 20,
  "unread": true,
  "from": "someone@example.com",
  "subject": "meeting",
  "since": "1-Jun-2026"
}
```

### email_read

```json
{
  "account": "School Mail",
  "uid": 12345,
  "folder": "INBOX"
}
```

## Auth modes summary

| Mode | Accounts | Login frequency | User action |
|------|----------|-----------------|-------------|
| Basic | QQ, 163, 126 | Permanent | None |
| OAuth2 interactive | Outlook.com, Gmail | Once | Login in browser on first use |
| OAuth2 headless | Office 365 federated | Every ~1 hour | None (automatic) |

## Limitations

- Read-only, no sending
- HTML emails are rendered as plain text
- OAuth2 headless tokens expire ~1 hour, auto re-login takes ~10 seconds

## License

MIT
