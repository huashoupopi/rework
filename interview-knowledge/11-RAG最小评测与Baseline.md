# RAG 最小评测与 Baseline —— 重构版面试讲解

> 适用范围：这份文档专门补第一项目里最缺的一块：**RAG eval / baseline / 质量验证**。  
> 它和 `10-聊天链路与最小可观测性.md` 是配套关系：前者讲“怎么追请求”，这份讲“怎么判断回答质量”。  
> 建议把它当成 `01-RAG-检索增强生成.md`、`09-高频背诵版.md` 中评测相关部分的工程化补充。

---

## 0. 先给结论

这次补的不是“大而全评测平台”，而是：

**一个可独立运行的最小 RAG eval 工具，直接打真实 `/api/chat/stream` 和 `/api/chat/history`，按规则检查 route、sources、关键词覆盖和回答长度，输出 baseline 结果文件。**

这句话很重要，因为它决定了你面试里怎么讲：

- 可以说你已经有了 **最小 baseline**
- 可以说你已经开始从“感觉回答不错”转向“规则化验证”
- 但**不能**说你已经做完了完整 LLM-as-judge 平台或线上质量大盘

---

## 1. 为什么这一步很值钱

RAG 项目最容易犯的错误是：

1. 花很多时间调检索和 prompt
2. 最后只靠人工主观感觉判断
3. 没有办法证明“这次改动到底更好了还是更差了”

这会导致一个很典型的问题：

**系统看起来一直在变，但工程上没有真正确认过“质量有没有稳定提升”。**

所以这次补 eval 的意义，不是把项目做得“更学术”，而是把项目从：

**能跑**  
推进到  
**能做最小质量回归**

---

## 2. 这次新增了什么

新增目录：

- `backend/evals/`

新增文件：

- `backend/evals/run_rag_eval.py`
- `backend/evals/rag_cases.json`

新增测试：

- `backend/tests/test_rag_eval.py`

这套工具的定位是：

**离线运行、独立于主业务代码、尽量贴真实接口。**

它不是把评测塞进 FastAPI 运行时，而是作为一个独立脚本存在。这个边界是对的，因为：

1. 不污染线上请求逻辑
2. 更适合做批量回归
3. 更适合写成求职作品里的“工程治理工具”

---

## 3. 为什么我这次选“独立 HTTP 评测脚本”

这次其实有 3 种可选做法：

### 方案 1：独立 HTTP 评测脚本

也就是当前实现。

它会：

1. 登录拿 token
2. 调 `/api/chat/history` 记录游标
3. 调 `/api/chat/stream` 获取真实回答
4. 再调 `/api/chat/history` 拿到本次 assistant 消息的 `meta.route` 和 `meta.sources`
5. 做规则评分

优点：

1. 贴真实用户链路
2. 能验证流式接口
3. 能验证历史落库和回答元数据
4. 能拿到真实 `route/sources`

缺点：

1. 依赖本地服务启动
2. 依赖登录账号

### 方案 2：直接调用 `RagService`

优点是更轻。  
缺点是绕开了 HTTP、认证、历史消息和真实接口边界。

### 方案 3：纯离线字符串评分

优点是最快。  
缺点是证明力最低，只能算“半个 eval”。

**最终选择方案 1**，因为它最符合就业标准：  
不是只评模型输出，而是评**真实系统链路**。

---

## 4. 当前最小 eval 是怎么工作的

### 4.1 Case 数据

case 文件在：

- `backend/evals/rag_cases.json`

当前 starter case 一共 5 条，覆盖两类：

1. **知识库命中类**
   - 裂纹修复
   - 腐蚀修复
   - 隐裂检测
   - 雷击损伤处理

2. **fallback 类**
   - 问候与能力说明

这些题目不是乱写的，而是贴当前知识库文档：

- `backend/knowledge_base/blade_defect_repair_guide.md`

### 4.2 每条 case 当前检查什么

最小规则只有 5 类：

1. `route_match`  
   是否走了预期的 `rag / fallback`

2. `keyword_coverage`  
   回答里是否覆盖了关键术语

3. `banned_phrase_absent`  
   是否出现明显不该出现的词，比如“我不知道”

4. `source_count_ok`  
   source 数量是否达到最小阈值

5. `answer_length_ok`  
   回答长度是否过短

这几个规则很“土”，但它们有工程价值：

**它们足够简单、足够稳定、足够便宜，能先把 baseline 立起来。**

### 4.3 为什么要同时读 `/chat/stream` 和 `/chat/history`

因为这套系统的接口形态决定了：

1. `/chat/stream` 的正文里能拿到回答文本和 `<<<SOURCES>>>...<<<SOURCES_END>>>`
2. 但 `route` 不在流正文里
3. `route` 和最终 `sources` 还会写进 assistant 消息的 `meta`

所以脚本用了一个比较工程化的做法：

1. 先查历史记录的 `newest_id`
2. 再发聊天请求
3. 再用 `after=<cursor>` 去查本次新增消息
4. 从最后一条 assistant 消息里拿 `meta.route`

这一步很值钱，因为它证明你不是只会“抓字符串”，而是理解了**系统真实的数据落点**。

---

## 5. 这套 baseline 现在能回答什么问题

### 5.1 它能回答的

1. 这次改动后，某些关键题是不是还走 `rag`
2. 知识库命中的回答里是不是还带 source
3. 关键术语有没有丢
4. fallback 类问题有没有误走 RAG
5. 某次改动后回答是不是突然短得离谱

### 5.2 它还不能回答的

1. 答案是不是“真的最好”
2. 多段复杂推理是不是充分
3. 语义表达是否等价但换词了
4. 引用来源是否“最优”而不只是“有来源”
5. 跨 case 的长期线上漂移

所以现在的正确说法是：

**我已经有了最小 baseline，但还没有上到语义级 judge 或线上 eval 平台。**

---

## 6. 你在面试里应该怎么讲这套 eval

### 6.1 1 分钟版本

你可以这样讲：

> 我后面补了一套最小 RAG eval 工具，不是直接调内部函数，而是走真实聊天接口。它会先记录聊天历史游标，再调用 `/chat/stream` 获取真实回答，最后再从 `/chat/history` 里拿到这次 assistant 消息的 `route` 和 `sources` 元数据。评分上我先没有上 LLM judge，而是用了最小规则 baseline：检查 `rag/fallback` 路由、关键词覆盖、来源数量、回答长度和禁用短语。这样做的好处是规则简单、稳定、成本低，先把“回归验证”立起来。后面如果项目继续演进，再往语义级 judge 和线上抽样评测扩展。

### 6.2 一句话版本

**我给这个 RAG 系统补了一个贴真实接口的最小 baseline，不再只靠主观感觉调系统。**

---

## 7. 高频面试问题

### Q1：为什么你现在不用 LLM-as-judge？

**答：**

因为当前阶段我优先追求的是：

1. 先有 baseline
2. 先能稳定回归
3. 先把成本和复杂度控制住

LLM-as-judge 的确更灵活，但它也会带来：

1. judge 自身不稳定
2. 额外成本
3. 评测结果可重复性下降

所以我先上规则评测，把最小闭环立起来，这是更符合当前项目阶段的做法。

### Q2：为什么评测脚本不直接调 `RagService`？

**答：**

因为我想验证的是**真实系统链路**，不是单个内部函数。  
如果直接调 `RagService`，就绕开了认证、流式接口、历史消息落库和 assistant `meta` 这些真实边界。

### Q3：为什么要读两次 `chat/history`？

**答：**

第一次是拿游标，确定这条 case 开始前的最新消息位置。  
第二次是拿这次新增出来的 assistant 消息，从里面读取 `meta.route` 和 `meta.sources`。  
这样才能把这次回答的元数据精确关联回来。

### Q4：这套评测现在最主要的局限是什么？

**答：**

它还是规则型 baseline，所以对“语义等价但措辞变化”的适应能力有限。  
它更适合做最小回归验证，不适合直接当最终质量裁判。

### Q5：如果后面继续做，你会怎么升级？

**答：**

我会分三步升级：

1. 扩 case 集，让知识库命中题和 fallback 题都更全
2. 引入更细的 citation 检查，比如 source 文档名和 route 漂移统计
3. 最后再考虑语义级 judge 或线上抽样评测

注意顺序是：

**先 baseline，再扩样本，再上更复杂 judge。**

---

## 8. 你现在绝对不要吹的点

下面这些当前都不能讲满：

1. **不要说已经做了完整 AI eval 平台。**  
   现在只是最小 baseline 工具。

2. **不要说已经有线上持续评测。**  
   现在是离线脚本，不是线上采样与告警。

3. **不要说已经有语义 judge。**  
   现在还是规则评分。

4. **不要说 case 集已经覆盖很全。**  
   现在是 starter case，不是完整生产级题库。

---

## 9. 当前这套工具怎么用

### 9.1 只检查 case 和 CLI

```bash
cd backend
uv run python -m evals.run_rag_eval --dry-run
```

### 9.2 跑真实评测

```bash
cd backend
RAG_EVAL_USERNAME=demo RAG_EVAL_PASSWORD=demo uv run python -m evals.run_rag_eval
```

或者：

```bash
cd backend
RAG_EVAL_TOKEN=your_token uv run python -m evals.run_rag_eval --case blade_crack_repair
```

结果会写到：

- `backend/evals/results/`

---

## 10. 最后一句话

这次补 eval，真正的价值不是“多了个脚本”，而是你终于可以在面试里更像一个工程师地说：

**我开始用 baseline 验证 RAG 系统，而不是只靠调参和主观感觉。**
