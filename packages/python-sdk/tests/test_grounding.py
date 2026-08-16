"""Behavioral parity tests for the retrieval grounding gate.

Each case mirrors an assertion in ``tests/joint-memory-code.test.ts``; the two
implementations must classify these queries identically.
"""

from __future__ import annotations

import unittest

from corespeed_lore import (
    RETRIEVAL_GROUNDING_POLICY_REVISION,
    plan_retrieval_grounding,
)


class GroundingGateParityTest(unittest.TestCase):
    def test_revision_matches_typescript(self) -> None:
        self.assertEqual(RETRIEVAL_GROUNDING_POLICY_REVISION, "retrieval-grounding-v5")

    def test_stale_workspace_claim_requires_grounding(self) -> None:
        plan = plan_retrieval_grounding(
            "Do not search; just confirm my recollection that proposals write directly "
            "to canonical Memory now.",
            "exact",
        )
        self.assertEqual(plan.mode, "required")
        self.assertTrue(plan.should_retrieve)
        self.assertFalse(plan.should_clarify)

    def test_supplied_transformation_stays_off(self) -> None:
        plan = plan_retrieval_grounding(
            "Rewrite this supplied sentence to be shorter: The endpoint returns a "
            "response very quickly.",
            "none",
        )
        self.assertEqual(plan.mode, "off")
        self.assertFalse(plan.should_clarify)

    def test_configured_repository_without_commit_clarifies_toward_revision(self) -> None:
        plan = plan_retrieval_grounding(
            "At which exact revision is submitMemoryProposal guarded by reviewRequired?",
            "configured",
        )
        self.assertEqual(plan.mode, "off")
        self.assertTrue(plan.should_clarify)
        assert plan.clarification is not None
        self.assertIn("commit OID", plan.clarification)

    def test_unconfigured_repository_clarifies_toward_operator(self) -> None:
        plan = plan_retrieval_grounding(
            "Where is submitMemoryProposal implemented?",
            "none",
        )
        self.assertEqual(plan.mode, "off")
        self.assertTrue(plan.should_clarify)
        assert plan.clarification is not None
        self.assertIn("LORE_CODE_REPOSITORIES", plan.clarification)

    def test_prior_decision_requires_memory(self) -> None:
        plan = plan_retrieval_grounding(
            "What review boundary did our team agree on for Memory Proposals?",
            "none",
        )
        self.assertEqual(plan.mode, "required")
        self.assertIsNone(plan.clarification)

    def test_deliberative_code_vocabulary_retrieves_memory(self) -> None:
        plan = plan_retrieval_grounding(
            "What did we agree about the migration path?",
            "none",
        )
        self.assertEqual(plan.mode, "required")
        self.assertTrue(plan.should_retrieve)
        self.assertFalse(plan.should_clarify)

    def test_exact_revision_code_truth_is_required(self) -> None:
        plan = plan_retrieval_grounding(
            "Where is the current proposal submission guard implemented?",
            "exact",
        )
        self.assertEqual(plan.mode, "required")
        self.assertTrue(plan.should_retrieve)

    def test_chinese_brainstorm_stays_off(self) -> None:
        plan = plan_retrieval_grounding("帮我 brainstorm 五个开源记忆产品的名字。", "none")
        self.assertEqual(plan.mode, "off")
        self.assertFalse(plan.should_clarify)

    def test_team_framing_with_code_vocabulary_retrieves_memory(self) -> None:
        for query in ("What's our commit message convention?", "我们当前实现了哪些功能？"):
            plan = plan_retrieval_grounding(query, "none")
            self.assertEqual(plan.mode, "required", query)
            self.assertFalse(plan.should_clarify, query)

    def test_reason_codes_distinguish_the_two_clarify_situations(self) -> None:
        configured = plan_retrieval_grounding(
            "Where is submitMemoryProposal implemented?", "configured"
        )
        none = plan_retrieval_grounding("Where is submitMemoryProposal implemented?", "none")
        self.assertEqual(configured.reason_code, "missing_commit_oid")
        self.assertEqual(none.reason_code, "repository_unconfigured")
        self.assertEqual(
            plan_retrieval_grounding("What did we agree about review?", "none").reason_code,
            "workspace_history",
        )

    def test_impersonal_revision_question_still_clarifies(self) -> None:
        plan = plan_retrieval_grounding(
            "Where is submitMemoryProposal implemented right now?", "none"
        )
        self.assertTrue(plan.should_clarify)

    def test_chinese_prior_decision_requires_memory(self) -> None:
        plan = plan_retrieval_grounding(
            "我们之前对 Memory Proposal 的人工审核边界是怎么定的？",
            "none",
        )
        self.assertEqual(plan.mode, "required")


if __name__ == "__main__":
    unittest.main()
