"""多轮改写门卫：启发式，不用 LLM。

选定路线⑴：有对话历史且问题短，即改写。不依赖指代词。
不选⑵（有历史就改写）：长且自包含的追问也会多一跳 LLM。
禁止用 LLM 当门卫。
"""

REWRITE_MAX_LEN = 40


def needs_rewrite(question: str, *, has_history: bool) -> bool:
    if not has_history:
        return False
    return 0 < len(question.strip()) <= REWRITE_MAX_LEN
