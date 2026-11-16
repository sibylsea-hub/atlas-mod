# Atlas

Atlas 是一个 Claude Code 的 mod：在对话旁边开一个面板，把平时看不见的东西摆出来，并且能直接开关和编辑。它管这几样：

- **记忆**：每个项目的记忆文件，本会话挂载了哪些，整理、合并、归档。
- **CLAUDE.md**：全局的和各项目的，能直接看和改。
- **会话**：每个会话读写了什么、用过哪些 skill。
- **Skills**：有哪些、用了多少次，按本会话 / 本项目 / 全局开关。
- **提示词**：系统提示词由哪些段组成，关掉、改写、自己加段；对话里的注入（system reminder）；把指令里的 "the user" 换成一个名字。
- **工具**：这个会话给模型的全部工具，各自的说明占多少；每个工具可以一直带着、用到再加载或关掉，也可以改写说明，按本会话 / 本项目 / 全局保存。
- **Hooks**：settings 文件里的 hook，开关、修改、新增、删除。

桌面 App 里的面板有皮肤，在面板顶上「刷新」那一排最右边的下拉菜单里切换，选的是哪一套按电脑各自记住：

- **手帐**（默认）：点阵纸、胶带、彩色色带，按钮按功能分六种制式。
- **档案**：莫兰迪色的档案页，象牙纸、细金线和小花饰、酒红编号标签、衬线字。
- **地中海**：蓝白色的杂志页，钴蓝粗细线、大号衬线数字、蓝瓷砖花边、一点柠檬黄。
- **海岸小镇**：南法和意大利海边的小镇，彩色房子一路排到水边、绿百叶窗、青蓝的海和小帆船。

皮肤都定义在 `hooks/skins.ts` 里，要留住一套新的样子，就在那里加一个。一套皮肤可以带自己的纸张画法（页首插图、写在纸上的标题、行与行之间的纸带）：手帐的在 `hooks/paper.ts` 和 `hooks/journal.ts`，档案的在 `hooks/folio.ts` 和 `hooks/folio-look.ts`，地中海的在 `hooks/riviera.ts` 和 `hooks/riviera-look.ts`，海岸小镇的在 `hooks/porto.ts` 和 `hooks/porto-look.ts`。终端里是纯文字版，没有皮肤。

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

## 系统要求

macOS 和 Windows 都能用，需要 Python 3.9 或更新的版本：

- **macOS**：用系统自带的 `/usr/bin/python3`。
- **Windows**：优先用 uv 装的 Python（`~/.local/share/uv/python` 下最新的那个），没有的话用 PATH 里的 `python`。

Windows 上已知的限制：路径超过 260 个字符的文件读不到（会在扫描结果里记一条警告），除非系统开启了长路径支持；手帐皮肤用 Segoe Print 和楷体代替 Mac 的手札体，档案皮肤用 Georgia 和宋体（SimSun）代替 Mac 的 Baskerville 和宋体（Songti），地中海皮肤用 Georgia 和 Segoe UI 代替 Mac 的 Didot 和 Avenir Next，海岸小镇皮肤用 Georgia 和 Segoe UI 代替 Mac 的 Cochin 和 Avenir Next。

## 开发

```
claude plugin validate .
claude plugin test .
```

改动之后在会话里发 `/reload-plugins` 重新加载。

类型定义（`.claude-plugin/types/`）不在仓库里：它由 Claude Code 在加载这个 mod 时自己生成，所以刚克隆下来时要先让它加载一次，才能做类型检查。
