---
name: pi-email
description: 邮件读取插件。通过 IMAP 协议读取邮件，支持多账号、搜索、文件夹浏览。涉及邮件相关任务时应优先使用。不支持发送邮件。
version: 0.2.0
---

# Email

通过 IMAP 协议直接连接邮箱服务器读取邮件。支持三种认证方式。

## 工具

### email_list
列出或搜索邮件。参数：
- `account`: 账号名称（如 "QQ邮箱"、"学校邮箱"），不填则用第一个
- `folder`: 文件夹名（默认 INBOX）
- `limit`: 返回数量（默认 20）
- `offset`: 分页偏移
- `unread`: 只显示未读
- `from`: 按发件人筛选
- `subject`: 按主题筛选
- `body`: 按正文搜索
- `since` / `before`: 日期范围（如 "1-Jun-2026"）

### email_read
读取邮件完整内容。
- `uid`: 邮件序号（从 email_list 结果的 `[seq]` 获取）
- `folder`: 文件夹（默认 INBOX）
- `account`: 账号名称

### email_mark
标记邮件。参数：
- `seq`: 邮件序号（从 email_list 结果的 `[seq]` 获取）
- `mark`: 操作类型
  - `read` — 标记已读
  - `unread` — 标记未读
  - `junk` — 标记垃圾邮件（自动移动到垃圾文件夹）
  - `not_junk` — 取消垃圾标记（在垃圾文件夹中时自动移回收件箱）
  - `flag` — 加星标
  - `unflag` — 取消星标
- `folder`: 文件夹（默认 INBOX）
- `account`: 账号名称

### email_folders
列出所有文件夹。
- `account`: 账号名称

## 认证方式

插件支持三种认证方式，根据邮箱类型自动选择：

| 认证方式 | 适用场景 | 登录频率 |
|---------|---------|---------|
| 基本认证 | QQ邮箱、163邮箱等国内邮箱 | 永久（用授权码） |
| OAuth2 交互式 | 个人 Outlook.com、Gmail | 首次弹浏览器，之后自动刷新 |
| OAuth2 headless | 学校/企业 Office 365（联合认证） | 每小时自动 headless 重新登录 |

## 配置方法

在 `~/.pi/agent/settings.json` 的 `"pi-email"` 字段中添加账号。

### 1. 基本认证（QQ邮箱、163、126 等）

使用授权码/应用专用密码的邮箱，直接填入即可，无需额外操作。

```json
{
  "pi-email": {
    "accounts": [
      {
        "name": "QQ邮箱",
        "imap": { "host": "imap.qq.com", "port": 993 },
        "user": "xxx@qq.com",
        "pass": "授权码"
      }
    ]
  }
}
```

常用 IMAP 服务器：
| 邮箱 | IMAP 服务器 | 端口 | 密码获取方式 |
|------|------------|------|------------|
| QQ邮箱 | imap.qq.com | 993 | 设置→账户→生成授权码 |
| 163邮箱 | imap.163.com | 993 | 设置→POP3/IMAP→开启并获取授权码 |
| 126邮箱 | imap.126.com | 993 | 同 163 |

### 2. OAuth2 交互式（个人 Outlook.com、Gmail）

适用于 Microsoft 个人账号（@outlook.com / @hotmail.com）和 Google 账号（@gmail.com）。
**首次使用时会弹出浏览器**让用户手动登录授权（支持通行密钥/二次验证），之后自动用 refresh_token 刷新，无需再次登录。

#### 个人 Outlook.com / Hotmail

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

注意：
- scope 使用 `outlook.office.com`（不是 `outlook.office365.com`）
- authority 使用 `common`
- 不需要填 `pass` 和 `login_user`
- 首次调用 email 工具时会自动打开浏览器，授权一次后永久有效

#### Gmail

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
    "scopes": [
      "https://mail.google.com/"
    ],
    "redirect_uri": "http://localhost:8401/"
  }
}
```

注意：
- client_id 是 Thunderbird 的公开客户端 ID
- scope 使用 `https://mail.google.com/`
- 首次同样需要浏览器授权一次

### 3. OAuth2 headless（学校/企业 Office 365 联合认证）

适用于学校或企业的 Office 365 邮箱，通过 federated SAML 认证（如 Keycloak）。
插件自动启动 headless Chrome 完成整个登录流程，无需用户操作。

```json
{
  "name": "学校邮箱",
  "imap": { "host": "outlook.office365.com", "port": 993 },
  "user": "学号@学校域名",
  "pass": "学校登录密码",
  "auth_type": "oauth2",
  "login_user": "学校系统用户名",
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

字段说明：
- `user`: 邮箱地址
- `pass`: 学校 IdP 的登录密码
- `login_user`: 学校登录系统的用户名（如果和邮箱前缀不同时需要填写）
- `auth_type`: 必须为 `oauth2`
- `oauth2.authority`: 学校/企业用 `organizations`

前提条件：
- 需要 Chrome 浏览器安装在默认路径
- 学校账号不能有二次验证（MFA/TOTP）
- token 约 1 小时有效，过期后自动重新 headless 登录

## 配置引导

当用户说"帮我添加邮箱"、"配置邮箱"等时，按以下步骤引导：

1. 问用户邮箱地址是什么
2. 根据域名判断类型：
   - `@qq.com` → 基本认证，引导获取 QQ 邮箱授权码
   - `@163.com` / `@126.com` → 基本认证，引导获取授权码
   - `@outlook.com` / `@hotmail.com` → OAuth2 交互式（Microsoft 个人）
   - `@gmail.com` → OAuth2 交互式（Google）
   - 学校/企业域名（如 `@xxx.edu.jp`、`@company.com`）→ 问用户邮箱服务器是否为 Office 365
3. 生成对应配置，用 edit 工具写入 settings.json 的 `pi-email.accounts` 数组
4. 告知用户 `/reload` 后生效
5. 对于 OAuth2 交互式账号：告知首次使用时会弹出浏览器，需要手动登录授权一次，之后自动刷新

## 注意

- 本插件只读不写，不支持发送邮件
- `email_list` 返回的 `[seq]` 编号用于 `email_read` 的 uid 参数
- 配置在 settings.json 中，支持多账号
- OAuth2 token 缓存存储在 `~/.pi/agent/oauth-cache-*.json`，删除后会要求重新授权
