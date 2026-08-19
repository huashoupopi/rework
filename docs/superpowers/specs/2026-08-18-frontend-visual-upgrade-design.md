# rework 前端视觉升级设计(2026-08-18)

> **本文档地位**:取代 [`docs/2026-08-17_升级改造设计.md`](../../2026-08-17_升级改造设计.md) §一「批次 1:前端视觉升级」的全部内容。该节自本文档生效之日起**作废**,以本文档为准。
> **产生方式**:2026-08-18 所有者与架构窗口 brainstorming 逐段确认(明暗基调 → 语言策略 → 表格口径 → 强调色 → 地基方案 → 页面与彩蛋 → 工程预算),六段全部经所有者拍板。
> **执行方**:Grok(独立分支 `work/batch-1-3`)。**观感终审为所有者本人,AI 不得代判。**
> **前置**:批次 0 已于 2026-08-18 复验通过(前端 129/129、CI 双 job 绿、跟踪区干净、工作分支已开)。

---

## 一、目标与问题

**问题**:当前前端「平淡且不统一」。取证:`src/index.css` 2327 行里散落七八处手写 `backdrop-filter`,模糊值 12/14/16/20/22/24/30 各写各的;玻璃质感只在少数页面出现,页面之间的壳没有统一契约。

**目标**:
1. 全站转深色,建立**一次定义、处处复用**的视觉底座,消灭页面级手写样式。
2. 观感对标 [21st.dev](https://21st.dev/community/components) 社区组件的当代审美(动效、光效、层次)。
3. **每页风格一致**——差异只允许出现在内容,不允许出现在壳。
4. 彩蛋与细节做足,作为求职作品的记忆点。

**非目标(YAGNI,明确不做)**:双主题切换、整站 TypeScript 迁移、改路由结构(404 catch-all 是唯一例外)、改任何后端接口、改业务逻辑。

---

## 二、被本文档推翻的既有约束(必须显式声明,防止执行方照旧文档办事)

| 出处 | 原文约束 | 本次处置 |
|---|---|---|
| [前端基础设计 spec](2026-03-21-frontend-foundation-design.md) §10.1.1 | 「**克制版**液态玻璃,不全站铺满」 | **放宽**。仍禁止「低对比文字压复杂背景」,但玻璃与动效的使用面积不再受克制条款限制 |
| 同上 §10.5.1 | 「同页玻璃层级 ≤1-2 主层」 | **放宽为 ≤3**(背景层 / 容器层 / 卡片层),再多不许 |
| 同上 §10.5.1 | 「任务中心、知识库、用户管理页表格主体默认不使用玻璃底」 | **改口径**:表格**容器**走玻璃,表格**行**保持实色深底(见 §五) |
| [升级改造设计](../../2026-08-17_升级改造设计.md) §1.3 | 「⛔ 不引入 21st.dev 包依赖,照效果实现为本地组件」 | **推翻**。21st.dev 组件本就不是 npm 包,而是 `npx shadcn add` 落进仓库的**源码**;既然代码自持,没有理由重新造 |
| 同上 §1.3 | 「动效库允许新增 `motion` 一个依赖」 | **放宽**为两个:`motion` + `three`(后者仅登录/注册路由懒加载) |

> **保留不变的三条**:①文字对比度优先于视觉效果 ②不改业务逻辑/路由结构/后端 ③尊重 `prefers-reduced-motion`。

---

## 三、决策记录(所有者拍板,执行方不得自行推翻)

| # | 决策 | 理由 |
|---|---|---|
| D1 | **深色为主基调** | 21st.dev 的招牌效果(极光/光斑/光束/微光)本质依赖深色底,放白底上必然发灰;工业监测系统天然适配深色 |
| D2 | **混合 TypeScript**:新组件用 `.tsx`,现有 JSX 一行不改 | 21st.dev/shadcn 源码全是 TSX,零翻译成本;`@types/react` 已装,Vite/Vitest 天然支持混用。**面试问「为什么一半 TS」的答案就是这条** |
| D3 | **表格容器玻璃、行实色** | `backdrop-filter` 在长列表滚动时开销极大,必然掉帧。容器玻璃保证风格一致,行实色保证数据可扫 |
| D4 | **强调色 = 电光蓝**(现有 `#2667ff` 提亮版)+ 青色辉光 | **硬约束**:缺陷标签已占用红/橙/紫语义(裂纹 `#ff4d4f`、腐蚀 `#d35400`、隐裂 `#722ed1`、表面腐蚀 `#fa8c16`),强调色碰这三色会造成语义混淆 |
| D5 | **地基先行,不逐页做** | 逐页做必然风格漂移——当前「不统一」的病根正在于此 |
| D6 | 工作量不设上限,但**分轮 + 两个检查点** | 所有者裁定 token 充裕、不受封版日约束;真正的成本是所有者的评审时间,故压缩为两次集中评审 |

---

## 四、视觉地基(轮次 1 产出)

### 4.1 深色 token 层

`src/index.css` 的 `:root` 变量即现成接口,**重定义即可,不新增体系**。目标值:

```css
:root {
  /* 底色:深蓝黑 + 两处辉光 */
  --app-bg:
    radial-gradient(circle at top left, rgba(77, 141, 255, 0.16), transparent 34%),
    radial-gradient(circle at top right, rgba(34, 211, 238, 0.10), transparent 30%),
    linear-gradient(180deg, #070b14 0%, #0b1220 52%, #070d18 100%);

  /* 文字与实色面(相对浅色版整体翻转) */
  --surface-strong: #e8eefc;              /* 主文字 */
  --surface-muted: rgba(232, 238, 252, 0.62);
  --surface-solid: #0f1626;               /* 表格行 / 高密度区实色底 */
  --surface-soft: rgba(255, 255, 255, 0.04);
  --surface-border: rgba(255, 255, 255, 0.10);

  /* 玻璃 */
  --glass-bg: rgba(255, 255, 255, 0.06);
  --glass-bg-strong: rgba(255, 255, 255, 0.10);
  --glass-border: rgba(255, 255, 255, 0.14);
  --glass-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  --glass-shadow-strong: 0 16px 48px rgba(0, 0, 0, 0.55);

  /* 强调色(D4) */
  --accent: #4d8dff;
  --accent-strong: #7aa9ff;
  --accent-soft: rgba(77, 141, 255, 0.14);
  --glow-accent: 0 0 24px rgba(77, 141, 255, 0.45);
  --glow-cyan: 0 0 32px rgba(34, 211, 238, 0.35);

  /* 动效(新增,统一节奏) */
  --motion-fast: 120ms;    /* hover / 点击反馈 */
  --motion-base: 180ms;    /* 常规进场 */
  --motion-slow: 220ms;    /* 大块进场 / 路由切换 */
  --stagger-step: 50ms;    /* 列表错峰间隔 */
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);

  /* 圆角沿用现值,不动 */
}
```

**缺陷语义色**:色相保持不变(否则用户认知断裂),仅提亮以满足深色底对比度——裂纹 `#ff6b6e`、腐蚀 `#f0803c`、隐裂 `#9d6bff`、表面腐蚀 `#ffa940`。**改动必须同时更新 `TaskTable.jsx` 与任务详情的标注色,保持两处一致**。

#### 已核实的三项事实(2026-08-18 架构窗口实测,执行方可直接采信)

1. **`--surface-strong` 翻转是安全的**:全文件 9 处引用,**9 处全部是 `color:`**(第 48/73/99/254/301/466/742/965/1201 行),无一处用作背景或边框。故把它从深色 `#102038` 翻成浅色 `#e8eefc` 不会造成背景反色事故。
2. **`--surface-soft` 是死 token**:全仓零引用(仅第 21 行定义)。**直接删除,不要费力重定义**。
3. **真正的迁移工作量 = 70 处硬编码浅色**:`rgba(255, 255, 255, …)` **69 处** + `#fff` **1 处**。这些是深色化的主战场,必须逐处收敛到 token,而不是留在原地。收敛不掉的须列清单上报,不得静默保留。

### 4.2 antd 与自研组件同源(深色迁移最易翻车处)

antd 5 开 `theme.darkAlgorithm`,并通过 `ConfigProvider` 把 `colorPrimary` / `colorBgContainer` / `colorBorder` / `borderRadius` **映射到上面同一套 CSS 变量**。

⚠️ 不做这一步的后果:antd 表格是一种深色、自研卡片是另一种深色,同页两种黑。**这是本次最需要盯的一致性风险点。**

### 4.3 shadcn 底座初始化

仓库已装 `@radix-ui/react-slot`、`class-variance-authority`、`clsx`、`tailwind-merge`、`lucide-react`(即 shadcn 全套底座),仅缺 `components.json`。执行:

1. 新增 `tsconfig.json`(`allowJs: true`,配 `@/*` 路径别名),**不改动任何现有 `.jsx`**;
2. `npx shadcn@latest init`;
3. 新组件一律落在 `src/shared/ui/`,`.tsx` 原样保留。

**验证闸**:初始化后 `pnpm test:run` 必须仍是 129/129,`pnpm build` 必须通过。任一不过则停止上报。

### 4.4 组件库清单(轮次 1 必须交付)

| 组件 | 职责 |
|---|---|
| `GlassCard` | 接替 `GlassPanel`。**`GlassPanel` 保留为转发壳**(避免把重命名混进视觉 diff),标注 `@deprecated` |
| `GlassButton` | 全站按钮,参照 Liquid Glass Button |
| `AuroraBackground` | 动态流光背景(纯 CSS 渐变 + motion,**不用 WebGL**) |
| `SpotlightCard` | 光斑跟随鼠标 |
| `ShimmerText` | 标题微光(**仅标题,禁止用于正文**) |
| `StaggerList` | 列表错峰进场,时间走 `--stagger-step` |
| `PageTransition` | 路由切换渐入 |
| `AnimatedNumber` | 数字滚动 |
| `EmptyState` | 空状态插画 + 引导文案 |

---

## 五、页面改造清单与彩蛋

**一致性契约(每页强制)**:标题走 `PageHeader`(内含 `ShimmerText`)→ 内容装在 `GlassCard` 里 → 进场走 `StaggerList`。壳统一,只有内容不同。

| 页面 | 改造 | 彩蛋 |
|---|---|---|
| 登录 / 注册 | `AuroraBackground` + **three.js 低多边形 3D 风机** + 玻璃表单卡 + `GlassButton` | 加载动画=旋转叶片;**连续输错密码 3 次 → 叶片停转 + 「叶片检修中,请稍后再试」**;本地时间 22:00-06:00 背景切星空版;登录成功叶片加速后转场进首页 |
| 外壳 `AppShell` | 侧栏/顶栏玻璃化;当前导航项加辉光指示条;`PageTransition` | 连点 logo 5 次 → 叶片狂转 3 秒(不改任何状态) |
| 首页工作台 | 快捷入口改 `SpotlightCard`;指标用 `AnimatedNumber` 滚动进场 | 数字滚到位时微光一闪 |
| 任务中心 | 上传区拖拽悬停:边框流光 + 卡片轻微 3D 倾斜;统计卡 hover 光效;表格容器玻璃化、行实色 | 检测完成瞬间该行闪一次成功辉光;空表格用 `EmptyState`(风机插画) |
| 任务详情 | **缺陷框逐个描边进场**(模拟扫描仪扫过) | 缺陷类型标签 hover → 高亮图上对应的框 |
| 聊天 | 输入区换 Agent Elements `InputBar`;等待用 `SpiralLoader`;流式输出仅光标处流光 | 空对话给「随便问点什么」引导卡 |
| 知识库文档 / 分块配置 / 用户管理 | 表格容器一致化、工具栏玻璃、行 hover 微光、空状态 | — |
| 知识库重建 | 顶部流光进度线 | 重建完成撒一次极轻粒子 |
| **404(新增路由)** | Background Paths 动态线条 + 挂「停机检修中」牌子的风机 + 返回首页 | 页面本身即彩蛋 |

> **彩蛋纪律**:①一律不得改变业务状态或写入后端 ②一律受 `prefers-reduced-motion` 约束 ③失败时静默降级,不得抛错影响主流程。

---

## 六、从 21st.dev 借鉴的组件

**引入方式**:`npx shadcn@latest add <url>`,组件以**源码**落进仓库(不是 npm 依赖),可自由修改。这与本项目「代码自持」的叙事一致。

| 用途 | 组件 | 备注 |
|---|---|---|
| 登录/注册背景 | Aurora Background(Aceternity 版) | 纯 CSS + motion,无 WebGL |
| 404 背景 | Background Paths | 动态 SVG 线条 |
| 全站按钮 | Liquid Glass Button | |
| 卡片光效 | Spotlight Card | 首页入口卡、任务中心统计卡 |
| 标题 | Shimmer Text | |
| **聊天输入区** | **Agent Elements `InputBar`** | `npx shadcn@latest add https://agent-elements.21st.dev/r/input-bar.json` |
| 聊天等待/流式 | Agent Elements `SpiralLoader`、`TextShimmer` | |

> ⛔ **只拿零件,不拿整包**:Agent Elements 的 `AgentChat` 整包绑定 Vercel AI SDK 的 `UIMessage` 结构,与本项目现有 SSE 链路不兼容,**引入它会倒逼改后端,严禁**。
> 🔺 **登录页 3D 风机不走 Spline Scene**(需外部 3D 素材)。做法=three.js 程序化生成:塔筒圆柱 + 机舱方块 + 三片渐细叶片,约 50 行,无素材依赖。**兜底**:若实现受阻,退回 SVG 叶片方案,不得为此拖延轮次。

---

## 七、工程预算(防止 UI 变成无底洞)

- **运行时依赖上限 2 个**:`motion`;`three`(**仅** `/login`、`/register` 路由懒加载)。其余一律 CSS/Canvas 或组件源码。
- **主 bundle 增量 ≤ 80KB gzip**(不含登录路由 chunk)。`pnpm build` 后核对并记录。
- **动效时长一律取 token**,页面内不许写死毫秒数。
- **全局尊重 `prefers-reduced-motion`**:开启时关闭位移/缩放/循环动画,仅保留不透明度过渡。
- **标签页隐藏时暂停 WebGL / canvas 渲染**(`visibilitychange` 挂起 rAF)。理由:演示与面试现场笔记本风扇狂转极其掉分。
- **`backdrop-filter` 禁止用于滚动容器内部**(D3)。

---

## 八、测试策略

1. 现有 **129 条必须保持绿**。
2. 断言里写死视觉文案的,**只许改断言、不许改行为**,且须在 commit 说明写清「产品行为未变」。若确认是行为回归,则修行为并注明。
3. 新组件补**基本渲染测试**:能渲染 + `prefers-reduced-motion` 分支生效。
4. ⛔ **动效不做快照测试**(必然脆,维护成本远大于收益)。
5. CI 前端 job(`pnpm test:run` + `pnpm build`)须持续绿。

---

## 九、执行分轮与检查点

| 轮次 | 内容 | 出口 |
|---|---|---|
| **轮次 1 地基** | tsconfig + shadcn init + 深色 token + antd 同源 + 组件库 9 件 + `GlassPanel` 转发 | 129/129 绿、build 过、全站「变暗但不崩」 |
| **轮次 2 门面** | 登录 / 注册 / 404 / AppShell + 对应彩蛋 | 🚩 检查点 ①——**2026-08-19 已执行:技术验收过(138/138、build 过、three 真懒加载、主包增量 39KB gzip),观感判定「太朴素」,退回** |
| ~~轮次 2.5 风格实验~~ | ~~`/style-lab` 实验页~~ | ❌ **已作废**——所有者在 21st.dev 现场否掉了 shader 方向,无需再做实验页 |
| **轮次 2R 视觉返工**(08-19,见 §九-c) | 换配色 + 装 Magic UI / Motion Primitives + 用新组件重做门面页 | 🚩 检查点 ①-b:所有者看图定案 |
| 轮次 3 业务页 | 首页 / 任务中心 / 任务详情 / 知识库三页 / 用户管理 + 彩蛋 | 每页截图 |
| ~~轮次 4 聊天页~~ | ~~Agent Elements 零件接入~~ | ❌ **2026-08-19 作废**:聊天页已在轮次 3 用批准组件完成;且 Agent Elements 属**第三个组件库**,与 §九-c「只用 Magic UI + Motion Primitives」的一致性约束冲突。**风格一致优先于单个组件**,故不引入。前端至此收工。 |

**每轮一 commit 组,轮末跑全量测试 + build。轮次 1 未过出口条件,不得进入轮次 2。**

---

## 九-b、轮次 2 退回的根因诊断与轮次 2.5 规格(2026-08-19)

### 根因(实测,非主观判断)

轮次 2 观感被判「太朴素、像纯黑、没有特效」。查代码,原因是**参数过于保守**,不是实现缺失:

1. **底色实为近黑**:`--app-bg` 基色 `#070b14` = RGB(7,11,20),亮度约 4%,肉眼即纯黑。
2. **辉光透明度仅 0.16 / 0.10**:叠在 4% 亮度的底上几乎不可见——这解释了「轮次 1 和轮次 2 背景看着一样」。
3. **`AuroraBackground` 仅 31 行、单个色块**:一个 `motion.div` 在 ±8% 内做约 4 秒循环位移,是缓慢光斑,不是极光。
4. **完全缺三层**:噪点颗粒层、粒子层、真正的着色器背景。

> 🪝 **教训**:token 化把「改起来容易」解决了,没解决「该调到多少」。**视觉强度必须看真实渲染定,不能在文档里拍数值。**

### 轮次 2.5:`/style-lab` 实验页规格

**目的**:止住「AI 猜 → 所有者说不对 → 再猜」的循环。所有者从**真实运行的效果**里选,而不是从文字描述里选。

**硬要求**:

- **路由仅开发环境可见**(`import.meta.env.DEV` 条件注册),不得进入生产构建,不得挂在 `ProtectedRoute` 下。
- **4 套背景方案必须实质不同**,不得是同一方案调参:
  - **A 纯 CSS/Canvas**:有色深靛蓝底 + 三色相强辉光(alpha ≥0.35)+ 噪点颗粒层。零新依赖。
  - **B 真着色器**:流动渐变(参考 21st.dev shader 分类,如 Stripe-like gradient / Grain Gradient)+ 噪点。
  - **C 粒子星野**:canvas 缓慢漂浮粒子 + 极光带。
  - **D 工业科技风**:动态线条/网格 + 辉光节点(Background Paths 一路)。
- ⛔ **四套的底色一律不许用近黑**(基色亮度须明显高于 `#070b14`,要有可辨识的色相)。
- **3 套玻璃卡片样式**:①现状(1px 白边)②渐变描边 + 内发光 ③光斑跟随 + 强模糊 + 高光角。
- **每套背景上必须压真实内容**(一张登录表单卡 + 中文标题 + 中文正文),以便**在真实对比度下判断可读性**,不许只看空背景。
- 提供实时开关:粒子密度、噪点强度、动效总开关(用于预览 `prefers-reduced-motion` 效果)。
- 每套背景各截一张图存 `screenshots/lab-bg-{a,b,c,d}.png`。

**出口**:测试与 build 保持绿;所有者选定「背景 X + 卡片 Y」后写回本文档,再开轮次 2.6(把选定组合铺到门面页)。

---

## 九-c、视觉方案定案(2026-08-19,取代 §九-b 的实验页方案)

### 决策变更

§九-b 的 `/style-lab` 实验页**作废,不再执行**。原因:所有者在 21st.dev 现场看过 shader 候选后,判定那一路(高饱和流动渐变、粒子星野)**"太浮夸、颜色诡异"**,方向本身被否,再做四套实验页是浪费。

同时**放弃自研 shader 背景**,改为**复用成熟开源组件库**。

### 定调:两条否决线(本节最高优先级,后续所有视觉决策以此为准)

> **❌ 否决**:大面积高饱和炫彩(紫/粉/荧光绿/霓虹)、静止画面动个不停、颜色诡异。
> **✅ 要的**:低饱和深蓝灰底 + **动效藏在交互里**——静止时安静克制,鼠标悬停、点击、滚动进场时才有反馈。

**这条统一了所有者前后两次看似矛盾的反馈**:说轮次 2「太朴素」是因为**细节密度不够**;说 shader 候选「太浮夸」是因为**静止时颜色太满**。两者不冲突,目标是**静时克制、动时有惊喜**。

参考物是 DeepSeek Harness 官网(`deepseek.com/harness`,实测其实现为 WebGL2 着色器 + 2D canvas 点阵叠层)。⚠️ **参考的是"低饱和 + 交互光影"的调性,不是照抄**——所有者明确说过不必做成那样。

### 选定组件库(只用这两个,保证风格一致)

| 库 | 装机量 | 选它的理由 |
|---|---|---|
| **Magic UI** (`@dillionverma`) | 4.4M 浏览 / 22.3K 收藏 | 组件**自身不带颜色**(中性黑白灰 + 调用方指定强调色),不会引入"诡异颜色" |
| **Motion Primitives** (`@ibelick`) | 2.6M 浏览 / 13.5K 收藏 | 以克制、精致的动效原语著称,正是"低调有内涵" |

⛔ **禁止从第三个库引入组件**,除非先更新本节。风格一致性优先于单个组件的好看程度。

两者都建在 Tailwind + `motion` 之上,而 `motion` 轮次 1 已装,**新增运行时依赖预期为 0**。

### 配色定案(直接替换 `src/index.css` 的 `:root`)

根因诊断(§九-b)已确认旧底色 `#070b14` 亮度仅 4%、等同纯黑。新方案**抬亮底色 + 温和辉光**:

```css
--app-bg:
  radial-gradient(1200px 600px at 15% -10%, rgba(77,141,255,0.20), transparent 60%),
  radial-gradient(900px 500px at 85% 0%,   rgba(56,189,248,0.12), transparent 55%),
  linear-gradient(180deg, #101a30 0%, #0f172a 55%, #0b1220 100%);

--surface-strong: #e6edfb;
--surface-muted:  rgba(230,237,251,0.60);
--surface-solid:  #141d33;                  /* 表格行实底,比底色略亮以分层 */
--surface-border: rgba(148,180,255,0.14);   /* 边框带蓝相,不用纯白 */

--glass-bg:     rgba(140,175,255,0.07);     /* 玻璃带蓝相,不是纯白蒙版 */
--glass-border: rgba(160,195,255,0.16);

--accent:       #4d8dff;                     /* 保留不动:theme.js 与 theme-tokens.test.js 已锁 */
--accent-cyan:  #38bdf8;                     /* 由 #22d3ee 降下来,去荧光感 */
--glow-accent:  0 0 24px rgba(77,141,255,0.35);

--noise-opacity: 0.025;                      /* 全局噪点层,极淡,消色带 */
```

> 🪝 **关键判断**:辉光透明度取 0.20 / 0.12,**没有采用 §九-b 提的 0.35**。那个数值的前提是黑底;现在底色抬到 `#0f172a`(L\*≈15),再叠强辉光就会滑向"浮夸"。**抬底色 + 温和辉光**才是高级深色 UI 的做法,黑底 + 强辉光反而显脏。

### 选定组件与页面映射

| 用途 | 组件 | 来源 | 落点 |
|---|---|---|---|
| 鼠标光影 | `Spotlight`(导出 `BorderGlowSpotlight`) | Motion Primitives | 登录卡、首页快捷入口卡、任务卡 |
| 水波 | `Ripple` | Magic UI | 登录页风机背后、检测完成态 |
| 底纹 | `Dot Pattern` | Magic UI | 全站底层,极淡 |
| 边框流光 | `Border Trail` | Motion Primitives | 登录表单、**"检测中"状态**(兼作状态指示) |
| 主按钮 | `Interactive Hover Button` | Magic UI | 全站主行动按钮 |
| 点击反馈 | `Ripple Button` | Magic UI | 次级按钮 |
| 卡片氛围 | `Meteors` | Magic UI | 首页/空状态卡(稀疏、慢速,仅卡片范围内) |
| 光标 | `Smooth Cursor` / `Pointer` | Magic UI | 全站 / 局部彩蛋 |
| 文字微光 | `Animated Shiny Text` | Magic UI | 加载态、强调文案 |
| 流式文字 | `Text Shimmer Wave` | Motion Primitives | 问诊页流式输出 |
| 标题 | `Line Shadow Text` | Magic UI | 页面主标题 |
| 数字 | `Sliding Number` | Motion Primitives | **替换现有 `AnimatedNumber`**,首页指标 |
| 滚动入场 | `In view` | Motion Primitives | 列表、卡片组 |
| 面板切换 | `Transition Panel` | Motion Primitives | 标签页 |
| 边缘渐隐 | `Progressive Blur` | Motion Primitives | 长列表上下边缘 |
| 彩蛋 | `Scratch To Reveal` / `Comic Text` / `Morphing Text` / `Pixel Image` | Magic UI | 见彩蛋清单 |
| 工业底纹备选 | `Flickering Grid` / `Animated Grid Pattern` | Magic UI | 仅备选,默认不用 |

### 既有组件处置

- **`AuroraBackground`**:废弃。由新 `--app-bg` + `Dot Pattern` + `Spotlight` 取代。删除组件与其引用。
- **`WindTurbine3D`**:**保留并放大**。理由:风机是产品身份,不是炫技。要求——填满登录页左侧视觉区、材质改**低饱和深蓝灰金属 + 细边缘光**(不要高亮塑料感)、转速放慢、维持 `React.lazy` 懒加载不变。

### 安装方式与两个已知坑

```bash
# Magic UI(命名空间形式)
pnpm dlx shadcn@latest add @magicui/ripple
# Motion Primitives(完整 URL 形式)
npx shadcn@latest add "https://motion-primitives.com/c/spotlight.json"
```

> ⚠️ **坑 1:Tailwind 4 与 shadcn CLI**。motion-primitives 有已知 issue(ibelick/motion-primitives#112),在 Tailwind v4 项目下 CLI 可能报 `Cannot read properties of undefined (reading 'resolvedPaths')`。我们正是 Tailwind 4。**允许手动复制源码兜底**(组件均为单文件 MIT 开源),不必卡在 CLI 上。

> ⚠️ **坑 2:Magic UI 文档要求改 `tailwind.config.js`**(如 `Ripple` 需要注册 `ripple` keyframes)。**我们是 Tailwind 4,没有这个文件**,配置在 CSS 里。必须把文档给的 keyframes/animation **翻译成 CSS `@theme` / `@keyframes` 写进 `index.css`**,不要凭空创建 `tailwind.config.js`。

### 验收

- 138 个既有测试保持绿;新增组件补基础渲染测试。
- `theme-tokens.test.js` 必须同步更新并通过(改了 CSS 变量就要对齐 `theme.js`)。
- `pnpm build` 通过;主包 gzip 增量仍在 80KB 预算内。
- **观感自检(交付前 Grok 自己先过一遍)**:截图静止态,若画面"颜色很满、到处在动",就是踩了否决线,自行回收强度再交。

### ✅ 轮次 2R 验收通过(2026-08-19 01:30 架构台实测)

**技术面全项通过**:138/138 测试绿;`pnpm build` 过;**运行时依赖零新增**(仍只有 `motion` + `three`);未创建影子 `tailwind.config`(坑 2 避开);`AuroraBackground` 已删且无残留引用;`:root` 各变量与 §九-c 定案逐项一致;组件 21 个(Magic UI 14 + Motion Primitives 7)全部来自批准的两个库。

**一处优于本规格**:§九-c 只要求保留并放大 3D 风机,实现改为**渐进增强**——`WindTurbineSvg` 作 Suspense 兜底先秒出,`three.js` 加载完再升级为 3D;404 与侧栏 logo 直接用 SVG,避免为小图标拉入 ~700KB 的 three。**采纳,后续以此为准。**

**观感通过**:底色为有层次的深蓝灰而非纯黑,标题断行已修,门面页构图平衡,符合 §九-c 两条否决线。

### 📌 轮次 3 必须一并修掉的四项(架构台 2026-08-19 实测)

1. **404「停机检修中」重复**:`NotFoundPage.tsx` 第 17 行 `sign="停机检修中"` 与第 19 行标题重复。⚠️ **此项在轮次 2 已提出但未修**,本轮必须闭环。
2. **两个效果被压到阈值以下,装了等于没装**:
   - `DotPattern`:`--auth-page__dots` 颜色 alpha 0.22 × opacity 0.4 = **有效 0.088**
   - `Ripple`:`mainCircleOpacity = 0.08`
   - 二者在截图中完全不可见。
   > 🪝 **教训**:工单强调"不浮夸"导致实现方**把所有效果一律压到看不见**,又滑回"太朴素"一侧。否决线是**禁止大面积高饱和**,不是"一切从淡"。**交互态与底纹应当可辨识**,判据是:静止截图上肉眼能看出底纹存在,但不抢注意力。
3. **登录页风机上下被裁切**,且呈近黑剪影,§九-c 要求的"细边缘光"未实现,失去金属质感。
4. **AppShell「当前账号」卡**内"上传/复核/追问"三标签排布仍不规整,竖线与"复核"的关系不明确。

### 轮次 3:业务页(经所有者裁定,不再设检查点)

剩余 8 页,一次做完:`HomePage`、`TaskCenterPage`、`TaskDetailPage`、`ChatPage`、`KnowledgeDocumentsPage`、`KnowledgeChunkConfigsPage`、`KnowledgeRebuildPage`、`UsersPage`。组件落点见 §九-c 映射表。

### ✅ 轮次 3 验收通过 —— 前端批次 1 收工(2026-08-19 01:56 架构台实测)

提交 `a5c4d5b`。**139/139 测试绿;`pnpm build` 过;主包 gzip 127.00KB**(较轮次 2R 的 126.60KB 仅增 0.4KB——8 个页面几乎未进主包,路由拆分生效)。10 张 `round3-*.png` 截图齐备。

**四项待修全部闭环**:

1. 404 重复文案已去(仅保留牌子上一处)。
2. 效果强度已提到可辨识:`DotPattern` 有效透明度 0.088 → **0.31**(0.5 × 0.62);`Ripple` `mainCircleOpacity` 0.08 → **0.24**,尺寸 180→220,圈数 4→6。截图中底纹肉眼可见且不抢注意力,符合判据。
3. `WindTurbine3D` 材质已改(diff 46 行)。
4. 「当前账号」三标签重排为整齐的竖向时间线。

**一处记录**:`KnowledgeRebuildPage.jsx` 本轮未直接改动,其视觉由共享的 `PageWorkband` 与 `index.css`(本轮改 204 行)承接。经查截图 `round3-rebuild.png` 风格与其余页一致,**判定合规**——页面级一致性可由共享层达成,不强求每页都直接 import 新组件。

**前端至此收工**,轮次 4 已作废(见总览表)。后续进入批次 2(后端安全)。

---

## 十、验收

- 全站每页截图存 `frontend/myapp/screenshots/`;
- `pnpm test:run` 129/129(新增测试后为 129+N)、`pnpm build` 通过、CI 双 job 绿;
- **一致性硬清单逐页核对**:标题走 `PageHeader` ✓ / 容器走 `GlassCard` ✓ / 进场走 `StaggerList` ✓ / **页面内零手写 `rgba()` 与 `blur()`** ✓ ——任一不满足即打回;
- **观感终审:所有者本人**。AI 不得自行判定「好看」。

---

## 十一、风险与兜底

| 风险 | 兜底 |
|---|---|
| antd 深色与自研深色不同源,同页两种黑 | 轮次 1 出口强制目视核对;`ConfigProvider` 映射写在唯一位置 |
| 2327 行 CSS 里残留硬编码浅色(**已实测:70 处**) | 轮次 1 逐处收敛到 token;⛔ 不许用「全局替换」一把梭——其中部分白色是**玻璃高光**(应转 `--glass-border`/高光叠层),部分是**实色面**(应转 `--surface-solid`),两者含义不同,替错会让玻璃失去质感。收敛不掉的列清单上报 |
| three.js 风机实现受阻 | 退回 SVG 叶片,不拖轮次 |
| shadcn init 破坏现有构建 | 轮次 1 第一个出口就是 129/129 + build,不过即停 |
| 玻璃层叠导致文字对比度不足 | 保留旧 spec 该条约束;正文一律落在实色或 `--glass-bg-strong` 之上 |

---

## 十二、执行纪律

1. 在分支 `work/batch-1-3` 上工作,**不直接进 main**。
2. **一轮一组 commit**,轮末必须跑全量测试 + build 才能进下一轮。
3. 发现本文档与代码现实冲突(如某组件已不存在、某依赖装不上),**停下记录并上报,不得自行改设计**。
4. ⛔ 不改后端、不改路由结构(404 catch-all 除外)、不改业务逻辑。
5. 截图必须是真实运行截图,**不得用生成图冒充**。
