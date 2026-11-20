# Atlas

Atlas 是一个 Claude Code 的 mod：在对话旁边开一个面板，把平时看不见的东西摆出来，并且能直接开关和编辑。它管这几样：

- **记忆**：每个项目的记忆文件，本会话挂载了哪些，整理、合并、归档。
- **CLAUDE.md**：全局的和各项目的，能直接看和改。
- **会话**：每个会话读写了什么、用过哪些 skill。
- **Skills**：有哪些、用了多少次，按本会话 / 本项目 / 全局开关。
- **提示词**：系统提示词由哪些段组成，关掉、改写、自己加段；对话里的注入（system reminder）；把指令里的 "the user" 换成一个名字；不属于任何一段的部分（引擎的开头、启动会话的 App 追加的规则）也列出来，只读。
- **工具**：这个会话给模型的全部工具，各自的说明占多少；每个工具可以一直带着、用到再加载或关掉，也可以改写说明，按本会话 / 本项目 / 全局保存。
- **Hooks**：settings 文件里的 hook，开关、修改、新增、删除。

桌面 App 里的面板有皮肤，在面板顶上「刷新」那一排最右边的下拉菜单里切换，选的是哪一套按电脑各自记住：

- **手帐**（默认）：点阵纸、胶带、彩色色带，按钮按功能分六种制式。
- **档案**：莫兰迪色的档案页，象牙纸、细金线和小花饰、酒红编号标签、衬线字。
- **地中海**：蓝白色的杂志页，钴蓝粗细线、大号衬线数字、蓝瓷砖花边、一点柠檬黄。
- **海岸小镇**：南法和意大利海边的小镇，彩色房子一路排到水边、绿百叶窗、青蓝的海和小帆船。

皮肤都定义在 `hooks/skins.ts` 里，要留住一套新的样子，就在那里加一个。一套皮肤可以带自己的纸张画法（页首插图、写在纸上的标题、行与行之间的纸带）：手帐的在 `hooks/paper.ts` 和 `hooks/journal.ts`，档案的在 `hooks/folio.ts` 和 `hooks/folio-look.ts`，地中海的在 `hooks/riviera.ts` 和 `hooks/riviera-look.ts`，海岸小镇的在 `hooks/porto.ts` 和 `hooks/porto-look.ts`。嵌在终端里的面板是纯文字版，没有皮肤；从终端开出来的浏览器窗口（见下面「使用」）画的是桌面 App 的那一套，皮肤都在。

## 安装

在终端会话的输入框里：

```
/plugin install atlas --marketplace sibylsea-hub/atlas-mod
```

在命令行里：

```
claude plugin install atlas --marketplace sibylsea-hub/atlas-mod
```

在桌面 App 里（那里 `/plugin` 不能用）：点输入框旁边的 +，选 Plugins，Add marketplace 填 `sibylsea-hub/atlas-mod`，再 Add plugin。

## 使用

发 `/atlas` 打开面板。

- **在桌面 App 里**：面板嵌在对话旁边。
- **在终端里**（没有别的界面接着这个会话时）：面板开成一个浏览器窗口，画面和桌面 App 里一样，皮肤、插图、看板的拖放都在，每一下点按和面板里做的是同一件事。装了 Google Chrome（Windows 上是 Edge 或 Chrome）就是一个没有标签栏和地址栏的独立窗口，没有的话用默认浏览器打开。窗口已经开着时再发 `/atlas`，只会告诉你它开着。
- `/atlas window`：不管在哪个界面，都开一个浏览器窗口。
- `/atlas pane`：不开窗口，用嵌入的面板（终端里是纯文字版）。

浏览器窗口只连本机：`bin/atlas_window.py` 在 `127.0.0.1` 上随机挑一个端口，页面（`web/`）只和它说话，不加载任何外面的东西。会话结束或者 mod 重新加载之后，窗口会提示已经断开，再发一次 `/atlas` 就有新的。

## 系统要求

macOS 和 Windows 都能用，需要 Python 3.9 或更新的版本：

- **macOS**：用系统自带的 `/usr/bin/python3`。
- **Windows**：优先用 uv 装的 Python（`~/.local/share/uv/python` 下最新的那个），没有的话用 PATH 里的 `python`。

Windows 上已知的限制：路径超过 260 个字符的文件读不到（会在扫描结果里记一条警告），除非系统开启了长路径支持；手帐皮肤用 Segoe Print 和楷体代替 Mac 的手札体，档案皮肤用 Georgia 和宋体（SimSun）代替 Mac 的 Baskerville 和宋体（Songti），地中海皮肤用 Georgia 和 Segoe UI 代替 Mac 的 Didot 和 Avenir Next，海岸小镇皮肤用 Georgia 和 Segoe UI 代替 Mac 的 Cochin 和 Avenir Next。

## 开发

```
claude plugin validate .
claude plugin test .
/usr/bin/python3 -I bin/test_atlas.py
/usr/bin/python3 -I bin/test_atlas_window.py
```

后两条是两个 Python 脚本自己的测试（Windows 上把 `/usr/bin/python3` 换成 `python`）。浏览器窗口那一个会在本机起一个真的服务，但不会打开任何窗口：环境变量 `ATLAS_WINDOW_NO_OPEN=1` 让 `bin/atlas_window.py` 什么窗口都不开，自己动手试的时候也可以用。

改动之后在会话里发 `/reload-plugins` 重新加载。

类型定义（`.claude-plugin/types/`）不在仓库里：它由 Claude Code 在加载这个 mod 时自己生成，所以刚克隆下来时要先让它加载一次，才能做类型检查。
