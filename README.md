# 答题助手 · Exam helper（DSH Go 原生 + DSH 网页端 双支持）

盯着屏幕，认出题目后把「第 N 题 · B」和答案原文弹成顶部通知。题库可选：查表约 1 秒，模型约 2 秒。

**同一个包，两端都能用：**

| 环境 | 界面 |
|---|---|
| **DSH Go 手机 App（原生）** | 面板（自检 / 题库 / 最近作答）+ 输入框「+」入口 + 「答题助手」小胶囊 |
| **DSH 网页端**（手机浏览器、电脑浏览器） | 输入框上方一个小胶囊「● 答题」，点开才展开题库数 · 导入题库 · 开始 / 停止 |

答题逻辑只有一份（`payload/watch.mjs`），两端共用同一个引擎和手机桥接。
网页端导入题库直接选本地文件：手机上选手机文件，电脑上选电脑里的文件。

## 运行前提（很重要）

这个插件的输入是**这台手机正在显示什么**——它通过「手机操控」读屏。所以：

| 前提 | 说明 |
|---|---|
| **安卓手机** | iOS 系统不允许读其他 App 的屏幕，**iOS 上用不了**（即使装了 DSH Go） |
| **装了 DSH Go App，且引擎跑在这台手机上** | 下载：<https://go.dshtui.com> |
| **手机操控已开启** | 设置 → 手机操控（无障碍 / Shizuku / 自连 ADB 任一） |
| **用时保持亮屏、解锁** | 熄屏会自动停止读屏任务 |

不支持的环境：

- **电脑 / NAS 上的纯 dsh web**：没有手机屏幕可读，也没有 `dshGo` 宿主，插件不会出现入口
- **远程主机 / 无头容器**：同上
- **iOS**：系统限制

> 换句话说：只有「装了 DSH Go 的安卓手机 + 引擎跑在本机」才是完整可用的环境；
> 同一台手机切「网页界面」也能用，因为背后还是这台手机的引擎。

## 安装

```sh
dsh plugin add dsh-go-exam-helper
```

或在 DSH Go 的 **插件 → 插件市场** 里点安装。装好后引擎重启会把脚本部署到 `~/.dsh/dsh-go/exam-helper`（可用 `DSH_EXAM_DIR` 改）。

## 用

1. 打开考试页面（浏览器 H5、小程序、原生 App 都行，只要是"题 + A/B/C/D"）
2. 点输入框上方的 **答题助手 · 未开始**，在面板里点「开始」
3. 切题时会弹通知：`第 7 题 · 📚 B` / `题库：35周岁`；没命中题库时是 `第 7 题 · B`

## 放自己的题库（可选）

把 `bank.json.example` 复制成 `bank.json`，按同样结构填：

```json
{ "items": [
  { "q": "题干文字", "options": [
      { "letter": "A", "text": "选项一" },
      { "letter": "B", "text": "选项二" }
    ], "answer": "B", "source": "分类" }
] }
```

命中题库的题会带 📚 前缀；没命中的题交给模型，答案会标 `？` 表示置信度低。

## 需要什么

- DSH Go（用手机桥接读屏）并开启 **手机操控**
- 一个支持读图的模型（DeepSeek 账号默认即可）
- 图形推理题正确率约 40%，会照常给答案但不保准；多选、判断也能答

## 隐私

- 截图只用于识别题目，只发给**你自己配置的模型**，不经过第三方
- 日志只记题目摘要和答案；失败现场截图最多留 200 张，`ctl.sh clean` 可清空
- 包里不含任何第三方题库

## 许可

MIT

---

# Exam helper (DSH Go plugin)

Watches the phone screen and pushes the detected answer as a heads-up notification (`Q7 · B`, plus the option text). A local answer bank is optional: drop your own `bank.json` next to the runtime to answer in ~1s from the bank, otherwise it asks your model (~2s).

**Install**: `dsh plugin add dsh-go-exam-helper` or use DSH Go → Plugins → Marketplace.

**Use**: open the quiz page, tap the "Exam · idle" strip above the composer, press Start. Notifications appear as you move between questions.

**Privacy**: screenshots are only sent to the model you configured; logs keep question summaries, not images. No third-party question bank is bundled.

MIT licensed.
