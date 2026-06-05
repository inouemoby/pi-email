# pi-email

Email reading extension for [pi coding agent](https://github.com/earendil-works/pi-mono). Connects to mail servers via IMAP protocol. Supports standard password auth and OAuth2 with automatic headless browser login.

## Install

```bash
pi install git:github.com/inouemoby/pi-email
```

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Chrome](https://www.google.com/chrome/) installed at default path (OAuth2 accounts only)

## Configure

Add accounts to `~/.pi/agent/settings.json` under the `"pi-email"` field.

### Standard IMAP (password / app password)

```json
{
  "pi-email": {
    "accounts": [
      {
        "name": "My Mail",
        "imap": { "host": "imap.example.com", "port": 993 },
        "smtp": { "host": "smtp.example.com", "port": 465 },
        "user": "user@example.com",
        "pass": "app-specific-password"
      }
    ]
  }
}
```

Common IMAP servers:

| Provider | IMAP Server | Port | Auth |
|----------|-------------|------|------|
| QQ Mail | imap.qq.com | 993 | Authorization code |
| Gmail | imap.gmail.com | 993 | App password |
| 163 Mail | imap.163.com | 993 | Authorization code |
| 126 Mail | imap.126.com | 993 | Authorization code |

### Office 365 with OAuth2 (school / corporate)

For Office 365 accounts that require OAuth2 and federated SAML login (common in Japanese universities). Uses headless Chrome to complete the full login chain automatically — no browser window pops up.

```json
{
  "name": "School Mail",
  "imap": { "host": "outlook.office365.com", "port": 993 },
  "smtp": { "host": "smtp.office365.com", "port": 587 },
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
| `login_user` | Username for the school login form (if different from email) |
| `oauth2.client_id` | Thunderbird public client ID — usually no need to change |

OAuth2 login flow (fully automatic):

1. Plugin detects expired access_token
2. Launches headless Chrome in background
3. Navigates Microsoft login → federated IdP → fills credentials → receives callback
4. Exchanges authorization code for access_token
5. Connects IMAP with token
6. Token cached in memory for ~1 hour

Requirements for OAuth2:
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

## Limitations

- Read-only, no sending
- OAuth2 token expires ~1 hour, auto-refresh takes ~10 seconds
- No MFA support for OAuth2 accounts
- HTML emails are rendered as plain text

## License

MIT
