# dsh-screenshot

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的 QQ 式截图插件：`Ctrl+Alt+Z` 或输入框旁的「截图」按钮 → 框选区域 → 图片直接作为附件进当前会话，会话跑完自动清掉临时图。

## 功能

- **全局快捷键 `Ctrl+Alt+Z`**：窗口没在前台也能截（宿主端起一个常驻的 PowerShell 守望进程轮询按键）。
- **输入框旁一个「截图」按钮**，和「电脑操作」「陪看」并排；点一下就截。
- **截图时可选择隐藏当前窗口**：先把本窗口藏起来再截，截完立刻还原，不会把自己拍进画面。
- **框选**：按下快捷键后全屏冻一张图，拖出矩形即可；`Enter` / 双击 = 整屏，`Esc` = 取消。
- **截完直接发**：图片走输入框自己的附件通道（等于你自己粘贴一张图），开关打开时自动 `submit()`。
- **自动清理**：这一轮会话跑完就删掉这轮留下的临时截图；没用上的图 30 分钟后也会被清。
- **工具行滚轮左右滑**：输入框下面那条工具行条目太多会挤爆，装上后可以直接用滚轮横向滚动。

## 安装

在 DSH 的插件管理器里按包路径装（本地开发用 `link:` 即可）：

```
plugin_manager install_bundle  target=link:/path/to/dsh-screenshot
```

装完刷新一下页面，输入框的工具行里就会出现「截图」。

## 用法

| 操作 | 结果 |
| --- | --- |
| `Ctrl+Alt+Z` | 截全屏并进入框选 |
| 点「截图」按钮 | 同上 |
| 拖出一块区域 | 只截这一块 |
| `Enter` / 双击 / 点「整屏」 | 整屏 |
| `Esc` | 取消，临时图删掉 |
| 右键按钮 / 点 `▾` | 打开设置 |
| 在工具行上滚鼠标滚轮 | 工具行左右滑 |

设置里两个开关（默认都开）：

- **隐藏当前窗口**：截图前先把本窗口藏起来，截完自动还原。
- **自动发送**：图进输入框后立刻发出去。关掉的话图会停在输入框里，等你自己按发送。

## 实现

```
index.js          宿主端：路由、截图调度、热键守望进程、临时图清理
client.js         界面端：工具行按钮、全屏框选层、设置弹层、附件注入
cordis.patch.yml  往 agent 组合里插一行
lib/capture.ps1   找窗口 → 可选隐藏 → CopyFromScreen 整屏截图 → 裁剪/缩放
lib/hotkey.ps1    GetAsyncKeyState 轮询 Ctrl+Alt+Z，命中就回连宿主路线
lib/cleanup.ps1   清掉上一次遗留的热键守望进程，避免一次按键截两张
locale/           中英文案
```

宿主端的 HTTP 路由（前缀 `/dsh-screenshot`）：

| 路由 | 用途 |
| --- | --- |
| `GET  /status` | 配置 + 热键进程状态，界面挂载时读一次 |
| `GET/POST /config` | 读写配置（POST 需要自定义头 `x-dsh-screenshot`） |
| `POST /capture` | 截一张，返回 `{id, width, height, url}` |
| `GET  /file?id=` | 取图（PNG） |
| `GET  /pending` | 热键截的图，一次性交付 |
| `POST /hotkey` | 热键守望进程回连入口（带一次性令牌） |
| `POST /cleanup` | 按图 id 或按会话 id 清临时图 |

几个实现上的取舍：

- **找窗口按标题，不按 pid**。DSH 的界面窗口和后端进程不是同一个进程，`process.pid` 那条路一定会找错。
- **中文标题不传命令行**，写进一个 UTF-8 文件再由脚本读，避开控制台代码页。
- **隐藏窗口一定写在 `finally` 里还原**，截图炸了也要把窗口还给你。
- **附件走输入框自己的隐藏 `<input type="file">`**，派发 `change` 就等于用户自己选了文件；没有 file input 时退回到合成 `paste` 事件。
- **热键只由宿主端守望进程触发**，界面只轮询 `/pending`，同一按键不会截两次。

## 配置与临时文件

都放在 `%TEMP%\dsh-screenshot\`：

- `config.json`：`{ "hide": true, "autoSend": true, "hotkey": true }`
- `shots\`：临时截图，会话结束或超过 30 分钟就删

## 限制

- 只在 Windows 上跑（截图和热键都靠 PowerShell + Win32 API）。
- 框选层用的是冻结图，多显示器时按虚拟屏整块截，选的时候按比例映射回去。
- 需要 PowerShell 5.1+（Win10/11 自带）。

## License

MIT
