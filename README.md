# WorkHealthier · 健康工位

Rokid Glasses 上的办公健康助手（AIUI 0.17.0，单绿色显示，480 × 352）。它用眼镜的姿态传感器判断你有没有低头、歪头，用眼镜相机加屏幕上的二维码标记估算眼睛到显示器的距离，坐姿不佳、离屏幕太近或久坐时在镜片上提醒，并可朗读一句提示。

## 先说清楚：眼镜没有红外/激光测距

AIUI 0.17 的设备能力只有蓝牙、加速度计、绝对方向传感器、陀螺仪和电池，Rokid Glasses 硬件本身也只有一颗 12 MP 相机和 IMU，没有 ToF、红外或激光测距模块。因此：

| 需求 | 本项目的做法 | 依据 |
| --- | --- | --- |
| 坐姿 / 低头 / 歪头 | Page 级世界感知 `enableWorldAwareness()` 提供的 `AbsoluteOrientationSensor`（Android `TYPE_ROTATION_VECTOR`，融合了陀螺仪、加速度计和磁力计），以“坐直正视屏幕”的姿态为基准算相对旋转，得到低头/仰头角和歪头角 | 官方 Page API 文档、`samples/gyroscope-test` |
| 眼睛到屏幕的距离 | 相机每 20 秒拍一张低分辨率照片，`BarcodeDetector` 识别显示器上的二维码标记（内容 `WH:50` 表示标称边长 50 mm），按标记在画面中的大小算距离；可在已知距离处一键校准 | 官方 `samples/scanner`（同一条拍照 → WebP 解码 → 条码识别的链路） |
| 久坐 | 连续监测 45 分钟提醒起身 | — |

用户说的“陀螺仪”功能就是上面的绝对方向传感器：它在设备内部已经融合了陀螺仪数据，直接给出姿态四元数，比手动积分陀螺仪角速度稳定得多。

## 导入 AIUI Studio

AIUI 工程根目录是仓库的 `agent/` 子目录（里面直接有 `app.json`），不是仓库根：

```text
Repository: https://github.com/cnYui/WorkHealthier
Ref: main
AIUI project directory: agent
```

在 Studio（https://aiui.rokid.com）左上角“新建智能体”菜单里选 **GitHub 导入**，填 `https://github.com/cnYui/WorkHealthier/tree/main/agent`，确认导入。再次导入同一个地址会原地更新工程。

导入后在对话里发 `/debug`，让它运行 `pages/monitor/index`，卡片出现后点“进入”，画布会移到 480 × 352 的效果预览窗口；右侧设备模拟面板有四个镜腿按钮。

**网页模拟器里没有传感器和相机**（之前实测：`navigator.mediaDevices` 不存在，姿态传感器也没有数据），所以 Page 会在 1.5 秒后自动进入**演示模式**，用 150 秒一循环的脚本依次演示：良好 → 低头提醒 → 恢复 → 离屏幕太近提醒 → 恢复 → 歪头提醒 → 看不到标记 → 正常。真机上则使用真实传感器和相机。

## 镜腿操作

| 操作 | 模拟器发出的键 | 作用 |
| --- | --- | --- |
| 单击 | `GlobalHook` → `Enter` | 有提醒时：关闭提醒；否则执行当前焦点项的动作（见下表） |
| 前滑 / 后滑 | `GlobalHook` → `ArrowUp` / `ArrowDown` | 在 5 个焦点项之间循环 |
| 双击 | 模拟器里不会送到 Page | 交给系统默认：退出智能体 |
| 点头 | 世界感知的 `nod` 手势（仅真机） | 关闭提醒 |

焦点项与单击动作：

| 焦点 | 单击 |
| --- | --- |
| 坐姿卡片 | 3 秒后以当前姿态重设基准（请坐直、正视屏幕）；传感器未连接时重试连接 |
| 屏幕距离卡片 | 立即拍照测一次距离；首次单击也会启动自动测量（相机需要用户操作才能开始） |
| 在 60 cm 处校准距离 | 拍照并把当前标记大小对应到 60 cm，结果存到本地 |
| 语音提醒 | 开 / 关 |
| 演示模式 | 开 / 关 |

Page 会对 `Enter`、`ArrowUp`、`ArrowDown` 调用 `preventDefault()`（完整接管焦点移动和确认），`Backspace` 保留系统默认。

## 提醒规则

| 提醒 | 条件 | 解除 |
| --- | --- | --- |
| 低头 / 仰头 | 相对基准 ≥ 18° 持续 8 秒（10°～18° 显示“注意”） | 姿态恢复 2 秒自动解除；单击/点头关闭后 60 秒内不再提醒 |
| 歪头 | ≥ 12° 持续 8 秒（7°～12° “注意”） | 同上 |
| 离屏幕太近 | < 45 cm 持续 15 秒且至少 2 次采样（45～52 cm “偏近”，> 85 cm “偏远”） | 回到 52 cm 以上自动解除；关闭后 60 秒冷却 |
| 久坐 | 连续 45 分钟 | 关闭后重新计时 |

所有阈值在 `agent/lib/posture.js`、`agent/lib/distance.js`、`agent/lib/session.js` 顶部的常量里。

## 屏幕距离标记

1. 在显示器上打开 `docs/marker.html`（或直接打开 `docs/marker/marker-50mm.svg`），也可以打印贴在显示器边框。
2. 页面里的 10 cm 标尺和真实尺子对齐，标记的物理尺寸就正确了。
3. 眼镜里把焦点移到“在 60 cm 处校准距离”，坐在离标记 60 cm 处正视它，单击。校准后标记尺寸的误差会被抵消，之后只要标记别换尺寸就不用再校准。

未校准时用 Rokid Glasses 相机视场（约 96° 水平）估算的常数 `K = 0.446`，误差可能有 ±20%，卡片上会标“估算”。

## 轴向约定（真机待验证）

`agent/lib/quat.js` 里的 `DEFAULT_AXIS_MAP` 假设设备 X 轴为左右轴（绕它转是点头/低头）、Y 轴为竖直轴（转头）、Z 轴为前后轴（歪头），与官方 `samples/gyroscope-test` 的映射一致；`pitchDownSign = -1` 决定哪个方向算“低头”。符号错了只会让“低头/仰头”标签互换，不影响是否检测到偏离。真机上把焦点放在坐姿卡片，低头时看角度文字是否显示“低头”，不对就改符号。

## 布局

Ink 参考画布 480 × 352（安全区左右 16 px、上下 12 px）：顶部状态行 → 两张指标卡片（坐姿 / 屏幕距离，28 px 大字）→ 两行说明 → 三个设置行 → 操作提示。对话流里的卡片是 448 × 150，用 `@media (max-height: 240px)` 只保留状态行和两张卡片。提醒以 2 px 虚线框覆盖在卡片区域上，状态同时用文字和符号（√ △ ▲ ○）表达，不只靠亮度区分。

## 目录

```text
agent/                     AIUI Studio 导入根
  AGENTS.md                智能体身份、语音路由规则、能力边界
  app.json                 页面、CAMERA 权限
  pages/monitor/index.ink  唯一的 Page：传感器、相机、镜腿输入、提醒、演示模式、两套布局
  lib/quat.js              四元数运算与轴向约定
  lib/posture.js           坐姿状态机（阈值、持续时间、冷却、统计）
  lib/distance.js          标记测距、校准、太近判定
  lib/session.js           会话计时、久坐提醒
  lib/capture.js           拍照 → 解码 → 识别 的一次测量
  lib/temple.js            镜腿输入去重（GlobalHook / 手势键）
  lib/demo.js              演示脚本
  lib/env.js               运行环境解析、本地设置
  lib/webp.js + vendor/    官方 scanner 示例的纯 JS WebP 解码器（见 THIRD_PARTY_NOTICES.md）
docs/marker.html           屏幕标记页面；docs/marker/*.svg|png 为 30/50/80 mm 标记
docs/aiui-audit.md         UX / 能力审计矩阵（未取得签名的 Studio 和真机证据前所有行都是 BLOCKED）
tests/                     Node 单元测试（不会被导入 Studio）
```

## 开发

```bash
npm test
python C:/Users/yui/.claude/skills/rokid-aiui-agent/scripts/validate_aiui_project.py agent --repository-root . --target-version 0.17.0 --strict
npx --yes --package @yodaos-pkg/aix-cli@0.8.2 aix pack agent -o artifacts/workhealthier.aix
npx --yes --package @yodaos-pkg/aix-cli@0.8.2 aix preview agent --html-out artifacts/preview.html
```

需要 Node 20+。`tests/` 覆盖 `agent/lib/` 里的全部纯逻辑，包括把演示脚本整段回放过两个状态机、确认每种提醒都会出现又都会解除。

## 状态

- 本地：单元测试、严格结构校验、AIX 打包/列表/预览都已通过。
- Studio 模拟器：只能验证布局、焦点、演示模式和镜腿键顺序；传感器和相机在模拟器里不存在。
- 真机：尚未验证。需要在眼镜上确认的有：`enableWorldAwareness()` 是否给出 `this.orientationSensor` 的 `reading` 事件、轴向符号、`takePhoto()` 在非用户操作的定时器里是否允许（不允许时 Page 会自动切到“单击测量”模式）、WebP 解码耗时、点头手势、语音合成。
- 上架前必须在 Studio“构建与提审”里勾选摄像头权限并说明用途（只在本地识别屏幕标记，不保存不上传）。
