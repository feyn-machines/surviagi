"""What the translation pass asks about, and which answers it keeps (Issue #78)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_pipeline import observation_translation as t


def row(**fields):
    base = {"observation_id": "obs-1", "task": "Answer tickets.", "task_zh_cn": None, "scale": None, "scale_zh_cn": None,
            "conditions": None, "conditions_zh_cn": None, "actor_name": "OpenAI", "actor_name_zh_cn": None, "facts": []}
    return {**base, **fields}


def fact(**fields):
    return {"fact_id": "fact-1", "what": "tickets closed", "what_zh_cn": None, "unit": "%", "unit_zh_cn": None, **fields}


class Copied(unittest.TestCase):
    def test_what_needs_no_call(self):
        for field, text in (("unit", "%"), ("scale", "10,000+"), ("task", "用 Claude 写脚本"), ("actor", "OpenAI"),
                            ("actor", "Goldman Sachs"), ("actor", "@handle"), ("actor", "karminski-牙医 (张旭红)")):
            self.assertEqual(t.copied_as_is(field, text), text, text)

    def test_what_needs_one(self):
        for field, text in (("task", "Answer tickets."), ("unit", "minutes"), ("actor", "a Virginia librarian"),
                            ("actor", "banks"), ("actor", "xeophon"), ("task", "OpenAI wrote code")):
            self.assertIsNone(t.copied_as_is(field, text), text)


class Checked(unittest.TestCase):
    def test_a_translation_keeps_its_numbers(self):
        self.assertEqual(t.checked("what", "closed 1,200 tickets in 3 days", "3 天内处理 1200 张工单"), "3 天内处理 1200 张工单")
        self.assertIsNone(t.checked("what", "closed 48 tickets", "处理了 84 张工单"))
        self.assertIsNone(t.checked("task", "Answer 24/7", "全天候回答"))

    def test_a_version_number_is_kept_as_written(self):
        self.assertEqual(t.checked("task", "Run version 5.5.1 of the model.", "运行该模型的 5.5.1 版本。"), "运行该模型的 5.5.1 版本。")
        self.assertIsNone(t.checked("task", "Run version 5.5.1 of the model.", "运行该模型的 5.5 版本。"))

    def test_a_number_may_be_written_the_chinese_way_at_the_same_value(self):
        for source, answer in (("1.2 million users", "120 万用户"), ("40k users", "4 万用户"), ("$77.3B market", "773 亿美元市场"),
                               ("200,000-line codebase", "20 万行代码库"), ("252 million visitors", "2.52 亿访客"),
                               ("a 1-trillion-parameter model", "1 万亿参数模型"), ("8.5K sessions", "8.5K 个会话"),
                               ("350 billion-dollar companies", "350 家十亿美元级公司"), ("5 minutes", "5 分钟")):
            self.assertEqual(t.checked("scale", source, answer), answer, source)

    def test_a_number_written_the_chinese_way_at_another_value_is_refused(self):
        for source, answer in (("1.2 million users", "12 万用户"), ("$77.3B market", "77.3 亿美元市场"), ("200,000 lines", "2 万行")):
            self.assertIsNone(t.checked("scale", source, answer), source)

    def test_an_answer_left_in_english_is_refused(self):
        self.assertIsNone(t.checked("task", "Answer tickets.", "Answer tickets."))
        for unit in ("million people", "days", "hires", "USD per ticket"):
            self.assertIsNone(t.checked("unit", unit, unit), unit)
        for unit in ("tokens/s", "tok/s", "GB", "ms", "Elo"):
            self.assertEqual(t.checked("unit", unit, unit), unit)
        # A unit or a name can rightly stay as written, and so can a wording that is itself a name.
        self.assertEqual(t.checked("unit", "tok/s", "tok/s"), "tok/s")
        self.assertEqual(t.checked("actor", "xeophon", "xeophon"), "xeophon")
        self.assertEqual(t.checked("what", "Finance & Accounting Index", "Finance & Accounting Index"), "Finance & Accounting Index")
        self.assertEqual(t.checked("conditions", "256GB M5 Mac Studio", "256GB M5 Mac Studio"), "256GB M5 Mac Studio")
        self.assertIsNone(t.checked("what", "Finance Index", "Other Index"))

    def test_an_empty_or_odd_answer_is_refused(self):
        for answer in (None, "", "  ", 3, ["x"]):
            self.assertIsNone(t.checked("task", "Answer tickets.", answer))


class Plan(unittest.TestCase):
    def test_only_what_is_missing_is_asked(self):
        copies, copied_facts, items = t.plan([row(
            task_zh_cn="回答工单。", conditions="a person checks refunds", actor_name="a librarian",
            facts=[fact(), fact(fact_id="fact-2", what_zh_cn="已译", unit="minutes", unit_zh_cn=None)])])
        self.assertEqual(copies, {})
        self.assertEqual(copied_facts, {"fact-1": {"unit": "%"}})
        self.assertEqual(items, [{"id": "obs-1", "conditions": "a person checks refunds", "actor": "a librarian",
                                  "facts": [{"id": "fact-1", "what": "tickets closed"},
                                            {"id": "fact-2", "unit": "minutes"}]}])

    def test_a_row_with_only_copies_makes_no_call(self):
        copies, _, items = t.plan([row(task="用 Claude 写脚本")])
        self.assertEqual(copies, {"obs-1": {"task": "用 Claude 写脚本", "actor": "OpenAI"}})
        self.assertEqual(items, [])


class Answers(unittest.TestCase):
    items = [{"id": "obs-1", "task": "Closed 48 tickets.", "facts": [{"id": "fact-1", "what": "tickets closed"}]},
             {"id": "obs-2", "task": "Answer email."}]

    def test_each_wording_stands_alone(self):
        batch = {"translations": [{"id": "obs-1", "task": "处理了 84 张工单。", "facts": [{"id": "fact-1", "what": "已处理工单"}]}]}
        observations, facts, refused = t.read_answers(self.items, [batch])
        self.assertEqual((observations, facts, refused), ({}, {"fact-1": {"what": "已处理工单"}}, 1))

    def test_a_row_the_model_left_out_is_not_a_refusal_and_stays_pending(self):
        observations, facts, refused = t.read_answers(self.items, [{"translations": [{"id": "obs-2", "task": "回复邮件。"}]}])
        self.assertEqual((observations, facts, refused), ({"obs-2": {"task": "回复邮件。"}}, {}, 0))

    def test_an_id_it_was_not_given_is_ignored(self):
        self.assertEqual(t.read_answers(self.items, [{"translations": [{"id": "obs-9", "task": "别的"}, "x"]}]), ({}, {}, 0))


if __name__ == "__main__":
    unittest.main()
