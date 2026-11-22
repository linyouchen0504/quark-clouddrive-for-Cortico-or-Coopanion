## 0.1.0

首个版本：授权码登录、账号信息（昵称、网盘空间、会员状态）展示、解除授权。
## 0.2.0

新增「每次操作前需确认」开关（默认打开）：开关打开时 AI 要动网盘会先返回等待确认，面板出现「AI 正在等确认」卡片，点同意放行本次操作，点拒绝则本次不继续。

## 0.3.0

新增文件操作工具：`qk_search` 按关键词搜索网盘文件、`qk_browse` 列出目录直接子项、`qk_download` 下载网盘文件到本地。AI 现在可以找到并读取网盘里的文件了。

## 0.3.1

修复两个 bug：
- `qk_download` 读取下载路径字段错误：CLI 返回 `filePath`，代码误读 `localPath`。
- `qk_search` / `qk_browse` 解析 CLI 输出时取行错误：CLI 输出 result + artifact 两行，旧逻辑取最后一行导致拿到 artifact 行而丢掉 `file_list`。现改为优先取 `type: "result"` 的行。
