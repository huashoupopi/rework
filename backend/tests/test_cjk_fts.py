"""B3：jieba 预分词。原文保留，FTS 另附空格行。"""

from app.services.cjk_fts import index_text_with_fts, tokenize_for_fts


def test_tokenize_inserts_spaces_for_chinese():
    spaced = tokenize_for_fts("齿轮箱渗漏")
    assert " " in spaced
    assert "齿轮" in spaced or "齿轮箱" in spaced


def test_index_text_keeps_original_for_eval_substring():
    indexed = index_text_with_fts("齿轮箱渗漏会导致涂层起泡脱落")
    assert "齿轮箱" in indexed
    assert "起泡" in indexed
    assert "\n" in indexed
    assert " " in indexed.split("\n", 1)[1]


def test_index_text_does_not_collapse_square_metre():
    indexed = index_text_with_fts("轻度:面积 < 0.1 m²,深度 < 1 mm")
    assert "0.1 m²" in indexed.split("\n", 1)[0]
