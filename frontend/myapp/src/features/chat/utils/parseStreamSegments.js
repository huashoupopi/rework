import { extractAssistantThink } from "./extractAssistantThink"

const THINK_PATTERN = /<<<THINK_START>>>(.*?)<<<THINK_END>>>/gs
const THINK_XML_PATTERN = /<think>([\s\S]*?)(?:<\/think>|$)/g
const SOURCES_PATTERN = /\n?<<<SOURCES>>>(.*?)<<<SOURCES_END>>>/s
const THINK_START = "<<<THINK_START>>>"
const THINK_END = "<<<THINK_END>>>"
const SOURCES_START = "<<<SOURCES>>>"
const SOURCES_END = "<<<SOURCES_END>>>"
const MARKERS = [THINK_START, THINK_END, SOURCES_START, SOURCES_END]

function parseSources(rawSources) {
  if (!rawSources) {
    return []
  }

  try {
    const parsedSources = JSON.parse(rawSources)

    return Array.isArray(parsedSources) ? parsedSources : []
  } catch {
    return []
  }
}

function stripTrailingPartialMarker(content) {
  let nextContent = content

  for (const marker of MARKERS) {
    for (let length = marker.length - 1; length > 0; length -= 1) {
      const partialMarker = marker.slice(0, length)

      if (nextContent.endsWith(partialMarker)) {
        nextContent = nextContent.slice(0, -length)
        break
      }
    }
  }

  return nextContent
}

function stripIncompleteBlock(content, startMarker, endMarker) {
  const startIndex = content.lastIndexOf(startMarker)

  if (startIndex === -1) {
    return content
  }

  const endIndex = content.indexOf(endMarker, startIndex + startMarker.length)

  if (endIndex === -1) {
    return content.slice(0, startIndex)
  }

  return content
}

export function parseStreamSegments(rawContent = "") {
  // 1. Extract think from <<<THINK_START>>> markers (primary)
  const thinkMatches = Array.from(rawContent.matchAll(THINK_PATTERN))
  let think = thinkMatches.map((match) => match[1] ?? "").join("").trim()

  // 1b. Streaming: extract partial think when END marker hasn't arrived yet
  if (!think) {
    const startIdx = rawContent.lastIndexOf(THINK_START)
    if (startIdx !== -1) {
      const afterStart = rawContent.slice(startIdx + THINK_START.length)
      if (!afterStart.includes(THINK_END)) {
        think = afterStart.trim()
      }
    }
  }

  // 2. Fallback: extract think from <think> XML tags
  let contentAfterMarkers = rawContent
  if (!think) {
    const xmlMatches = Array.from(rawContent.matchAll(THINK_XML_PATTERN))
    think = xmlMatches.map((match) => match[1] ?? "").join("").trim()
    if (think) {
      contentAfterMarkers = rawContent.replace(THINK_XML_PATTERN, "")
    }
  } else {
    contentAfterMarkers = rawContent.replace(THINK_PATTERN, "")
  }

  const sourcesMatch = contentAfterMarkers.match(SOURCES_PATTERN)
  const sources = parseSources(sourcesMatch?.[1])

  const rawDisplayContent = stripTrailingPartialMarker(
    stripIncompleteBlock(
      stripIncompleteBlock(
        contentAfterMarkers
          .replace(THINK_PATTERN, "")
          .replace(SOURCES_PATTERN, ""),
        THINK_START,
        THINK_END,
      ),
      SOURCES_START,
      SOURCES_END,
    ),
  ).trim()

  const fallbackParsed = extractAssistantThink(rawDisplayContent)
  const content = fallbackParsed.displayContent
  const fallbackThink = fallbackParsed.think

  return {
    content,
    sources,
    think: think || fallbackThink,
  }
}
