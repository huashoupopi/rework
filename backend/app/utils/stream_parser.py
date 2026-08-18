class ThinkStreamParser:
    THINK_OPEN = "<think>"
    THINK_CLOSE = "</think>"
    MARKER_START = "<<<THINK_START>>>"
    MARKER_END = "<<<THINK_END>>>"

    def __init__(self) -> None:
        self._in_think: bool = False
        self._buffer: str = ""
        self._think_content: str = ""
        self._passthrough: bool = False

    @property
    def think_content(self) -> str:
        return self._think_content.strip()

    def flush(self) -> str:
        remaining = self._buffer
        self._buffer = ""

        if self._in_think:
            self._think_content += remaining
            remaining += self.MARKER_END
            self._in_think = False
        return remaining

    def set_passthrough(self) -> str:
        """思考块结束后切换为直通模式，释放缓冲区并停止标签检测。"""
        remaining = self._buffer
        self._buffer = ""
        self._passthrough = True
        return remaining

    def feed(self, token: str) -> str:
        if self._passthrough:
            return token
        self._buffer += token
        output = ""

        while self._buffer:
            if self._in_think:
                end_pos = self._buffer.find(self.THINK_CLOSE)
                if end_pos != -1:
                    think_chunk = self._buffer[:end_pos]
                    output += think_chunk
                    output += self.MARKER_END
                    self._think_content += think_chunk
                    self._buffer = self._buffer[end_pos + len(self.THINK_CLOSE) :]
                    self._in_think = False
                else:
                    safe_len = len(self._buffer) - (len(self.THINK_CLOSE) - 1)
                    if safe_len > 0:
                        think_chunk = self._buffer[:safe_len]
                        output += think_chunk
                        self._think_content += think_chunk
                        self._buffer = self._buffer[safe_len:]
                    break
            else:
                start_pos = self._buffer.find(self.THINK_OPEN)
                if start_pos != -1:
                    output += self._buffer[:start_pos]
                    output += self.MARKER_START
                    self._buffer = self._buffer[start_pos + len(self.THINK_OPEN) :]
                    self._in_think = True
                else:
                    safe_len = len(self._buffer) - (len(self.THINK_OPEN) - 1)
                    if safe_len > 0:
                        output += self._buffer[:safe_len]
                        self._buffer = self._buffer[safe_len:]
                    break
        return output
