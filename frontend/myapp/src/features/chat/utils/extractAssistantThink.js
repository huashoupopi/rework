const THINK_LABEL_PATTERN = /(?:助手[回答]*[:：]\s*)?(?:Thinking Process|思考过程)\s*[:：]\s*/i
const THINK_WITH_CLOSE_PATTERN =
  /(?:助手[回答]*[:：]\s*)?(?:Thinking Process:\s*|思考过程[:：]\s*|<think>\s*)([\s\S]*?)(?:<\/think>)/g

export function extractAssistantThink(rawContent = "") {
  if (!rawContent) {
    return {
      displayContent: "",
      think: "",
    }
  }

  const thinkBlocks = []
  let displayContent = rawContent

  displayContent = displayContent.replace(THINK_WITH_CLOSE_PATTERN, (_, thinkContent = "") => {
    const normalizedThink = thinkContent.trim()
    if (normalizedThink) {
      thinkBlocks.push(normalizedThink)
    }
    return ""
  })

  const normalizedDisplay = displayContent.trim()
  const leakedThinkMatch = normalizedDisplay.match(THINK_LABEL_PATTERN)

  if (thinkBlocks.length === 0 && leakedThinkMatch && leakedThinkMatch.index === 0) {
    const leakedThink = normalizedDisplay.slice(leakedThinkMatch[0].length).trim()

    if (leakedThink) {
      thinkBlocks.push(leakedThink)
      displayContent = ""
    }
  }

  return {
    displayContent: displayContent.trim(),
    think: thinkBlocks.join("\n\n---\n\n").trim(),
  }
}
