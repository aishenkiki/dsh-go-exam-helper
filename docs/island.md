# 灵动岛（状态胶囊）能力设计

> 目标：把「盯屏中 / 已答 · 第 6 题 · 📚 B / 已停止」这类短状态显示在挖孔屏的胶囊里。
> 答案本身仍然走通知横幅，胶囊只显示状态和题号，避免和横幅抢位置。

## 为什么必须由 App 本体实现

| 事实 | 影响 |
|---|---|
| 插件只有 `composer.strip`、`panel`、菜单项、工具卡四个插槽，全在 App 内部 | 插件画不到状态栏或挖孔区 |
| 桥接的 `notify` 只接受 `title` / `text`，没有 id、样式、常驻参数 | 插件无法复用同一条通知做常驻胶囊 |
| 实测连发两条同名通知，通知栏里是两条独立通知 | 即使有 id 参数也必须 App 侧改 | 

结论：岛的绘制必须由 DSH Go 用原生通知实现，插件只做调用方。

## 平台依据

- 荣耀的「灵动胶囊」不对第三方单独开放 SDK；
- 但荣耀兼容 **Android 16 Live Updates（进度样式通知）**：发通知的应用使用
  `Notification.ProgressStyle` 并把 `setShortCriticalText()` 设置成短文本，系统就会把它渲染进胶囊。
- 其它厂商（小米焦点通知、ColorOS 胶囊）也走类似的进度通知 / 常驻通知机制，同一套实现可以复用。

## 能力形状（与现有 `strip` 对称）

插件清单声明：

```json
{
  "dshGo": {
    "contributes": {
      "island": [{ "id": "exam-island", "text": { "zh": "答题助手 · 未开始" }, "panel": "exam" }]
    }
  }
}
```

宿主注册：

```js
ctx.dshGo.island('exam-island', (scope, emit) => {
  emit({ text: '已答 · 第 6 题 · 📚 B', tone: 'info', progress: 6 })
})
```

- `text`：必填，一行，建议 ≤ 24 个字符（超过由 App 截断加省略号）
- `tone`：`info | good | warn | danger`，映射到底色/边框，默认 `info`
- `progress`：可选，正整数；给了就用进度样式（部分系统会显示进度条）
- 调用方按 App 给的节奏 emit，App 侧做「文字未变化就不重绘」的去重

## App 侧实现要点（Android）

1. 建一个低打扰通知渠道 `dsh_island`（`IMPORTANCE_LOW`，无声音、无震动）
2. 固定 `notificationId`（例如常量 `ISLAND_ID = 0x0D5H`），每次更新都 `notify(ISLAND_ID, …)`
3. 构造：

```kotlin
val style = Notification.ProgressStyle()
    .setStyledByProgress(false)
    .setProgress(progress)            // 有进度时
    .setProgressTrackerIcon(icon)
    .setShortCriticalText(shortText)  // 胶囊里显示的短文本，例如 "第 6 题 · B"

NotificationCompat.Builder(ctx, CHANNEL)
    .setSmallIcon(R.drawable.ic_dsh)
    .setContentTitle(text)            // 展开后的完整文本
    .setOngoing(true)
    .setOnlyAlertOnce(true)
    .setStyle(style)
    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
    .build()
```

4. 系统不支持进度样式（API < 36 或厂商未适配）时，降级为普通常驻通知；
   `island` 插槽在插件侧检测不到就退回 `strip`（状态条）。
5. 权限：`POST_NOTIFICATIONS`（Android 13+）。没有权限时 `island` 应返回 `{ ok: false, reason: 'no_permission' }`。

## 插件侧调用约定

```js
const island = ctx.dshGo.island
if (island) {
  island('exam-island', (scope, emit) => {
    emit({ text: `已答 · 第 ${no} 题 · ${mark}${letter}`, tone: 'info', progress: no })
  })
} else {
  // 老宿主：退回状态条
  ctx.dshGo.strip('exam-strip', …)
}
```

答题助手的开关存在运行目录的 `state.json` 里（`island: true/false`），默认关闭；
面板里提供一个开关，开启时提示「需要 DSH Go 支持胶囊通知」。

## 换机与重装

- **App 层能力**：随 App 本体，重装、换机都有
- **插件层调用**：插件发布在 npm，重装环境后一条命令装回
- 因此这套设计不依赖某台手机上的手工改动

## 验收清单

- [ ] 胶囊能在考试页常驻，切题时文字更新而不是新建通知
- [ ] 通知栏里只有一条胶囊通知，不会随题号累积
- [ ] 点「停止」后胶囊消失或变灰显示「已停止」
- [ ] 无通知权限时给出明确提示，不影响答题功能
- [ ] 老系统 / 老宿主上自动降级，不报错
