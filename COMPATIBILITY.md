# OpenClaw Channels 兼容性验证

## 验证结果

### ✅ 正常

| 命令 | 结果 |
|------|------|
| `openclaw clawatch status` | Connected: yes, Paired: 000000000000000 |
| `openclaw channels list` | Clawatch default: configured, enabled |
| `openclaw channels status` | Clawatch default: enabled, configured |
| `openclaw channels capabilities` | Support: chatTypes=direct, Actions: send, broadcast |

### ⚠️ 不支持（预期行为）

| 命令 | 结果 | 说明 |
|------|------|------|
| `openclaw channels login --channel clawatch` | Channel clawatch does not support login | 使用 `openclaw clawatch login` |
| `openclaw channels logout --channel clawatch` | Channel clawatch does not support logout | 使用 `openclaw clawatch logout` |

### 已修复（v0.1.4+）

| 命令 | 修复 |
|------|------|
| `openclaw channels resolve --channel clawatch <imei>` | 添加 resolver.resolveTargets，IMEI 即 ID |
| `openclaw message send --channel clawatch -t <imei> -m "test"` | 添加 sendMedia 存根（OpenClaw 要求 sendText+sendMedia 同时存在） |

## 推荐用法

- **登录/登出**：`openclaw clawatch login` / `openclaw clawatch logout`
- **配对/解绑**：`openclaw clawatch pair` / `openclaw clawatch unpair`
- **推送**：通过 Reminder/Cron 的 channel `clawatch`、`clawatch_push` 工具，或 `openclaw agent --channel clawatch --to <imei> --message "..." --deliver`
