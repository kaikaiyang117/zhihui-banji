---
name: 智汇·班记
description: 遵循 Apple Design 原则、面向教师日常工作的温润、清晰、可靠的本地教务工作台
colors:
  canvas: "#f4f3ef"
  surface: "#ffffff"
  surface-subtle: "#f8f7f3"
  ink: "#20242f"
  ink-secondary: "#5f6673"
  primary: "#5663b6"
  primary-soft: "#eef0fb"
  success: "#237a4b"
  warning: "#9a5a00"
  danger: "#b42318"
  border: "#dfe1e5"
typography:
  page:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "-0.025em"
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    lineHeight: 1.35
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.58
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  sm: "6px"
  control: "10px"
  card: "14px"
  dialog: "18px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "38px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "20px 24px"
motion:
  default:
    damping: 1.0
    response: "0.3-0.4s"
  momentum:
    damping: 0.8
    response: "0.3-0.4s"
---

# Design System: 智汇·班记

## Overview

**Creative North Star: “温润教务台”**

这是一个教师每天长时间使用的 Operate 界面。视觉应像整理好的系统工作台：温和、不喧闹，但任务、状态和下一步始终清楚。品牌个性来自准确的层级、克制的中性材质和可靠的反馈，而不是装饰。

界面保留现有系统字体与靛蓝识别色。强色只用于操作、焦点、选择和状态；普通信息依靠排版和空间形成层级。所有迁移均保持路由、业务逻辑、数据流、入口和核心交互路径不变。

**Key Characteristics:**

- 中性系统灰画布与高可读性的深色文字
- 稀缺而明确的靛蓝操作色
- 4px 基础间距形成紧密组与宽松区段
- 卡片默认平坦，浮层才获得明显阴影
- 信息密集但不使用低对比度小字隐藏复杂度

## Apple Design Contract

本系统采用 Apple Design 的原则作为交互视觉基线：

- **Response**：按下即反馈；状态变化不等待额外延迟。
- **Spatial consistency**：浮层从触发源出现，并沿相同空间路径收起。
- **Materials**：透明材质只用于结构性浮层，常规内容保持稳定、可读的实体表面。
- **Agency**：动效不锁住输入；所有非手势动效克制、可打断，并提供 reduced-motion 等价表现。

手势驱动组件若后续新增拖拽、滑动或抽屉，必须采用 1:1 pointer tracking、Pointer Capture、速度交接和 rubber-band 边界；本轮不新增手势行为。

## Colors

中性系统灰画布承载白色工作表面，靛蓝负责行动与定位，状态色只表达真实状态。

**The Rarity Gives Force Rule.** 主色只用于操作、选中、焦点和关键数字，不作为普通装饰。

**The Contrast Is Content Rule.** 正文、标签和元信息均达到 WCAG AA；层级通过字号、字重与空间表达，不依赖褪色文字。

## Typography

**Display Font:** 系统无衬线字体栈
**Body Font:** 系统无衬线字体栈

**Character:** 稳定、清晰、适合中文密集信息。全系统只使用一个字体家族，角色差异由字号、字重、行高和间距共同承担。

使用系统字体的 optical sizing。大标题使用轻微负 tracking，正文保持接近 0，12px 辅助文字使用轻微正 tracking；不得用同一个 letter-spacing 套用全部字号。

### Hierarchy

- **Page**（700，30px，1.18）：页面唯一主标题。
- **Section**（650，18px，1.35）：主要工作区标题。
- **Title**（650，14px，1.45）：卡片、列表和对象标题。
- **Body**（400，14px，1.58）：说明和常规内容。
- **Label / Meta**（12px，1.5）：控件标签和元信息，不再继续缩小。
- **Metric**（700，26px，1）：统计值使用 tabular numbers。

## Layout

主阅读路径始终是“页面目标 → 今日优先事项 → 当前操作区 → 支撑信息”。相关内容先用邻近关系分组，只有独立操作、独立滚动或需要明确边界的区域才成为卡片。

间距使用 4/8/12/16/24/32/40px。组件内部偏紧，区段之间明显放宽。桌面保留稳定侧栏；平板和手机只改变呈现，不改变入口和信息顺序。

## Elevation & Depth

系统平坦优先。常规卡片使用边框，不叠加阴影；菜单、弹窗、悬浮工具和拖拽状态使用带垂直偏移的柔和阴影。

**The Float Must Mean Something Rule.** 阴影只表示浮动、临时或正在交互的层级。

浮层进入时同时使用轻微 scale、opacity 和 blur 的 materialize 过渡；收起沿相同方向返回。默认采用无 overshoot 的 critically damped 感觉，只有带有明确动量的拖拽释放才允许 bounce。

## Shapes

小型结构使用 6px，控件使用 10px，卡片使用 14px，弹窗使用 18px。胶囊形只用于状态、筛选和紧凑上下文，不用于普通容器。

## Components

### Buttons

- 主按钮使用靛蓝实色、白字、10px 圆角和 38px 高度；手机端提高到 44px。
- 次按钮使用白色表面与明确边框。
- 危险按钮只在真正危险操作中使用红色。

### Cards / Containers

- 默认白色表面、14px 圆角、1px 边框、无阴影。
- 状态表面使用轻色背景、深色文字和对应边框，不依靠颜色单独传递含义。

### Inputs / Fields

- 控件高度不低于 38px，手机端不低于 44px。
- 焦点状态始终显示 3px 靛蓝轮廓。

### Navigation

- 活动位置必须同时使用背景、文字权重和图标状态表达。
- 移动端保持全部入口，但必须提供横向可发现性和悬浮控件避让。

## Do's and Don'ts

### Do:

- **Do** 用空间和排版先表达层级，再决定是否需要容器。
- **Do** 保留教师领域语言与现有业务顺序。
- **Do** 为键盘、触控和辅助技术提供同等清晰的状态。

### Don't:

- **Don't** 把每个信息组都包成带阴影的圆角卡片。
- **Don't** 使用低对比度小字隐藏次要信息。
- **Don't** 为一次性视觉差异新增 token 或通用组件。
- **Don't** 在视觉重构中改变路由、数据流、功能入口或核心交互路径。
