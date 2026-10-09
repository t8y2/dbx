import unittest
from summarize import summarize


class SummaryTests(unittest.TestCase):
    def test_separates_error_and_success_latency(self):
        rows = [{"kind": "sample", "scenario": "warm_query", "outcome": "success", "dispatch_ms": value} for value in range(1, 21)]
        rows.append({"kind": "sample", "scenario": "warm_query", "outcome": "error", "dispatch_ms": 9000})
        summary = summarize(rows)["scenarios"]["warm_query"]
        self.assertEqual(summary["outcomes"], {"success": 20, "error": 1})
        self.assertEqual(summary["by_outcome"]["success"]["dispatch_ms"], {"n": 20, "min": 1, "p50": 10, "p95": 19, "max": 20})

    def test_ignores_secret_unknown_fields_and_invalid_numbers(self):
        summary = summarize([{"kind": "sample", "scenario": "warm_query", "outcome": "secret", "password": "secret", "dispatch_ms": float("nan")}, {"kind": "sample", "scenario": "secret", "outcome": "success"}])
        self.assertNotIn("secret", str(summary))
        self.assertEqual(summary["scenarios"]["warm_query"]["by_outcome"]["unknown"], {})

    def test_does_not_call_a_completed_cancel_race_a_successful_cancel(self):
        summary = summarize([{"kind": "sample", "scenario": "cancel_race", "outcome": "completed_during_cancel_race", "jdbc_cancel_calls": 0}])
        self.assertEqual(summary["scenarios"]["cancel_race"]["outcomes"], {"completed_during_cancel_race": 1})


if __name__ == "__main__":
    unittest.main()
