---
name: pi-email
description: 邮件读取插件。通过 IMAP 协议读取邮件，支持多账号、搜索、文件夹浏览。涉及邮件相关任务时应优先使用。不支持发送邮件。
version: 0.1.0
---

# Email

通过 IMAP 协议直接连接邮箱服务器读取邮件。

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

### email_folders
列出所有文件夹。
- `account`: 账号名称

## 配置方法

在 `~/.pi/agent/settings.json` 的 `"pi-email"` 字段中添加账号。

### 普通邮箱（QQ邮箱、Gmail 等使用应用专用密码/授权码的邮箱）

```json
{
  "pi-email": {
    "accounts": [
      {
        "name": "QQ邮箱",
        "imap": { "host": "imap.qq.com", "port": 993 },
        "smtp": { "host": "smtp.qq.com", "port": 465 },
        "user": "xxx@qq.com",
        "pass": "授权码"
      }
    ]
  }
}
```

常用 IMAP 服务器：
| 邮箱 | IMAP 服务器 | 端口 | 认证方式 |
|------|------------|------|---------|
| QQ邮箱 | imap.qq.com | 993 | 授权码（设置→账户→生成授权码） |
| Gmail | imap.gmail.com | 993 | 应用专用密码 |
| Outlook(personal) | outlook.office365.com | 993 | 应用密码 |
| 163邮箱 | imap.163.com | 993 | 授权码 |
| 126邮箱 | imap.126.com | 993 | 授权码 |

### Office 365 学校/企业邮箱（OAuth2 自动登录）

适用于学校或企业的 Office 365 邮箱，通过 headless 浏览器自动完成 OAuth2 + SAML 联合认证。

```json
{
  "name": "学校邮箱",
  "imap": { "host": "outlook.office365.com", "port": 993 },
  "smtp": { "host": "smtp.office365.com", "port": 587 },
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
- `user`: 邮箱地址，用于 IMAP/SMTP 认证
- `pass`: 学校 IdP 的登录密码
- `login_user`: 学校登录系统的用户名（如果和邮箱地址不同时需要填写，例如邮箱是 `user@school.example.jp`，但登录用户名是 `user`）
- `oauth2.client_id`: Thunderbird 公开客户端 ID，一般不需要修改
- `oauth2.authority`: 使用 `organizations` 适用于学校/企业账号

OAuth2 自动登录原理：
1. 插件检测 access_token 过期
2. 启动 headless Chrome（后台运行，不弹窗）
3. 自动完成 Microsoft → 学校 IdP 的登录流程
4. 拿到 access_token 后连接 IMAP
5. token 缓存在内存中，约 1 小时有效

前提条件：
- 需要 Chrome 浏览器安装在默认路径
- 学校账号不能有二次验证（MFA/TOTP）

## 注意

- 本插件只读不写，不支持发送邮件
- `email_list` 返回的 `[seq]` 编号用于 `email_read` 的 uid 参数
- 配置在 settings.json 中，支持多账号
