from app.utils.stream_parser import ThinkStreamParser


def test_short_plain_text_stays_buffered_until_flush():
    """尾巴要留着，免得把下一片里的 <think> 切断。短句必须 flush 才出完。"""
    parser = ThinkStreamParser()
    assert parser.feed("叶片裂纹") == ""
    assert parser.flush() == "叶片裂纹"
    assert parser.think_content == ""


def test_think_block_becomes_markers():
    parser = ThinkStreamParser()
    out = parser.feed("前<think>内部推理</think>后")
    assert ThinkStreamParser.MARKER_START in out
    assert ThinkStreamParser.MARKER_END in out
    assert "内部推理" in out
    assert parser.think_content == "内部推理"
    assert "前" in out
    assert "后" in parser.flush()


def test_split_tokens_do_not_emit_partial_open_tag():
    parser = ThinkStreamParser()
    assert parser.feed("<thi") == ""
    out = parser.feed("nk>abc</think>ok")
    assert "abc" in out
    assert parser.think_content == "abc"
    assert parser.flush() == "ok"


def test_flush_closes_open_think():
    parser = ThinkStreamParser()
    parser.feed("<think>还没结束")
    remaining = parser.flush()
    assert ThinkStreamParser.MARKER_END in remaining
    assert "还没结束" in parser.think_content
