"""
Scenario Generator for the JSON Edit Engine

Purpose: Programmatically enumerate (state, action) combinations to surface
scenarios we should have test coverage for. Complements the hand-written
SCENARIOS.md by finding combinations we missed.

The generator works in two passes:

1. Enumerate reachable "state shapes" — abstract descriptions of engine state.
   Not full states (the value space is infinite) but coarse equivalence classes
   that are behaviorally distinct (e.g. "user session with 1 op, no copilot
   session" is one shape; "user session with 2 ops where op2 shadows op1" is
   another).

2. For each state shape, enumerate applicable actions and predict the
   post-state + observable outputs.

The output is a list of scenarios in the same format as SCENARIOS.md.

Run: python3 scenario_generator.py

Output: generated_scenarios.md alongside a coverage gap report against
the hand-written SCENARIOS.md.
"""

from dataclasses import dataclass, field
from enum import Enum
from itertools import product
from typing import Optional


# ---------------------------------------------------------------------------
# State Model
# ---------------------------------------------------------------------------

class SessionState(Enum):
    """High-level session lifecycle state."""
    NONE = "no_session"
    USER_ONLY = "user_session_open"
    USER_AND_COPILOT = "user_and_copilot_sessions_open"


class OpRelation(Enum):
    """Path relationship between two ops.
    Used to characterize user/copilot interactions."""
    NONE = "no_ops"
    SAME_PATH = "same_path"
    USER_DESCENDANT = "user_edits_descendant_of_copilot"
    USER_ANCESTOR = "user_edits_ancestor_of_copilot"
    UNRELATED = "unrelated_paths"


class OpKind(Enum):
    ADD = "add"
    REMOVE = "remove"
    REPLACE = "replace"


class ValueKind(Enum):
    """Coarse value types — for characterizing what's at a path."""
    SCALAR = "scalar"       # number, string, bool
    OBJECT = "object"
    ARRAY = "array"
    MISSING = "missing"


@dataclass(frozen=True)
class StateShape:
    """An equivalence class of engine states.
    
    Two engine states with the same StateShape are expected to exhibit
    the same behavior for any given action.
    """
    session: SessionState
    user_op_count: int           # 0, 1, 2+
    copilot_op_count: int        # 0, 1, 2+
    has_shadowed_user_op: bool   # does user session have ops at same path?
    has_shadowed_copilot_op: bool
    user_undo_depth: int         # 0, 1, 2+
    user_redo_depth: int         # 0, 1, 2+
    copilot_undo_depth: int
    copilot_redo_depth: int

    def describe(self) -> str:
        parts = [self.session.value]
        if self.user_op_count > 0:
            desc = f"user_ops={self.user_op_count}"
            if self.has_shadowed_user_op:
                desc += "+shadow"
            parts.append(desc)
        if self.copilot_op_count > 0:
            desc = f"copilot_ops={self.copilot_op_count}"
            if self.has_shadowed_copilot_op:
                desc += "+shadow"
            parts.append(desc)
        if self.user_undo_depth > 0:
            parts.append(f"u_undo={self.user_undo_depth}")
        if self.user_redo_depth > 0:
            parts.append(f"u_redo={self.user_redo_depth}")
        if self.copilot_undo_depth > 0:
            parts.append(f"c_undo={self.copilot_undo_depth}")
        if self.copilot_redo_depth > 0:
            parts.append(f"c_redo={self.copilot_redo_depth}")
        return " | ".join(parts)


# ---------------------------------------------------------------------------
# Action Model
# ---------------------------------------------------------------------------

class ActionKind(Enum):
    START_USER_SESSION = "engine.startUserSession()"
    START_COPILOT = "us.startCopilot()"
    USER_PROPOSE = "us.propose(op)"
    USER_PROPOSE_SAME_PATH = "us.propose(op)"  # targets existing user path
    USER_REVERT_TOUCHED = "us.revert(path)"     # path has a user op
    USER_REVERT_UNTOUCHED = "us.revert(path)"   # path has no user op
    USER_UNDO = "us.undo()"
    USER_REDO = "us.redo()"
    USER_COMMIT = "us.commit()"
    USER_DISCARD = "us.discard()"
    COPILOT_PROPOSE = "cs.propose(op)"
    COPILOT_PROPOSE_CONFLICT_SAME = "cs.propose(op) at user-touched path"
    COPILOT_PROPOSE_CONFLICT_ANCESTOR = "cs.propose(op) at user-touched ancestor"
    COPILOT_PROPOSE_CONFLICT_DESCENDANT = "cs.propose(op) at user-touched descendant"
    COPILOT_APPROVE = "cs.approve(path)"
    COPILOT_DECLINE = "cs.decline(path)"
    COPILOT_APPROVE_ALL = "cs.approveAll()"
    COPILOT_DECLINE_ALL = "cs.declineAll()"
    COPILOT_END = "cs.end()"
    COPILOT_UNDO = "cs.undo()"
    COPILOT_REDO = "cs.redo()"
    USER_EDIT_SAME_AS_COPILOT = "us.propose(op) at same path as pending copilot op"
    USER_EDIT_DESCENDANT_OF_COPILOT = "us.propose(op) at descendant of copilot op"
    USER_EDIT_ANCESTOR_OF_COPILOT = "us.propose(op) at ancestor of copilot op"
    USER_EDIT_UNRELATED = "us.propose(op) at path unrelated to copilot"


# What actions are applicable in what sessions?
ACTIONS_BY_SESSION = {
    SessionState.NONE: [
        ActionKind.START_USER_SESSION,
    ],
    SessionState.USER_ONLY: [
        ActionKind.START_COPILOT,
        ActionKind.USER_PROPOSE,
        ActionKind.USER_PROPOSE_SAME_PATH,
        ActionKind.USER_REVERT_TOUCHED,
        ActionKind.USER_REVERT_UNTOUCHED,
        ActionKind.USER_UNDO,
        ActionKind.USER_REDO,
        ActionKind.USER_COMMIT,
        ActionKind.USER_DISCARD,
    ],
    SessionState.USER_AND_COPILOT: [
        ActionKind.COPILOT_PROPOSE,
        ActionKind.COPILOT_PROPOSE_CONFLICT_SAME,
        ActionKind.COPILOT_PROPOSE_CONFLICT_ANCESTOR,
        ActionKind.COPILOT_PROPOSE_CONFLICT_DESCENDANT,
        ActionKind.COPILOT_APPROVE,
        ActionKind.COPILOT_DECLINE,
        ActionKind.COPILOT_APPROVE_ALL,
        ActionKind.COPILOT_DECLINE_ALL,
        ActionKind.COPILOT_END,
        ActionKind.COPILOT_UNDO,
        ActionKind.COPILOT_REDO,
        ActionKind.USER_EDIT_SAME_AS_COPILOT,
        ActionKind.USER_EDIT_DESCENDANT_OF_COPILOT,
        ActionKind.USER_EDIT_ANCESTOR_OF_COPILOT,
        ActionKind.USER_EDIT_UNRELATED,
    ],
}


# ---------------------------------------------------------------------------
# State Shape Enumeration
# ---------------------------------------------------------------------------

def enumerate_state_shapes() -> list[StateShape]:
    """Generate all behaviorally distinct state shapes within our abstraction."""
    shapes = []

    # NONE: only one shape possible.
    shapes.append(StateShape(
        session=SessionState.NONE,
        user_op_count=0, copilot_op_count=0,
        has_shadowed_user_op=False, has_shadowed_copilot_op=False,
        user_undo_depth=0, user_redo_depth=0,
        copilot_undo_depth=0, copilot_redo_depth=0,
    ))

    # USER_ONLY: vary user op count + undo/redo + shadow.
    # We use 0/1/2 as counts (2 represents "2 or more").
    for user_ops, shadow, undo, redo in product([0, 1, 2], [False, True], [0, 1, 2], [0, 1]):
        # Shadow requires at least 2 ops (original + shadowing op).
        if shadow and user_ops < 2:
            continue
        # Undo depth can't exceed total actions taken, but we keep it loose.
        shapes.append(StateShape(
            session=SessionState.USER_ONLY,
            user_op_count=user_ops, copilot_op_count=0,
            has_shadowed_user_op=shadow, has_shadowed_copilot_op=False,
            user_undo_depth=undo, user_redo_depth=redo,
            copilot_undo_depth=0, copilot_redo_depth=0,
        ))

    # USER_AND_COPILOT: vary both.
    # Keep this bounded — we don't need the full cartesian product,
    # just representative combinations.
    for u_ops, c_ops, u_shadow, c_shadow in product([0, 1, 2], [0, 1, 2], [False, True], [False, True]):
        if u_shadow and u_ops < 2:
            continue
        if c_shadow and c_ops < 2:
            continue
        shapes.append(StateShape(
            session=SessionState.USER_AND_COPILOT,
            user_op_count=u_ops, copilot_op_count=c_ops,
            has_shadowed_user_op=u_shadow, has_shadowed_copilot_op=c_shadow,
            user_undo_depth=0, user_redo_depth=0,  # simplify: ignore stacks here
            copilot_undo_depth=0, copilot_redo_depth=0,
        ))

    return shapes


# ---------------------------------------------------------------------------
# Scenario Generation
# ---------------------------------------------------------------------------

@dataclass
class Scenario:
    id: str
    state_shape: StateShape
    action: ActionKind
    expected_behavior: str
    covers_rule: list[str] = field(default_factory=list)

    def render(self) -> str:
        lines = [
            f"### {self.id}",
            "",
            f"**State shape:** {self.state_shape.describe()}",
            f"**Action:** `{self.action.value}`",
            f"**Expected:** {self.expected_behavior}",
        ]
        if self.covers_rule:
            lines.append(f"**Covers:** {', '.join(self.covers_rule)}")
        lines.append("")
        return "\n".join(lines)


def predict_behavior(shape: StateShape, action: ActionKind) -> tuple[str, list[str]]:
    """Given a state shape and action, predict behavior and which rules apply.
    
    This is where the spec gets encoded. Each branch here is one rule
    we've decided on — this function is essentially an executable summary
    of the spec.
    """
    rules = []
    
    # NONE state
    if shape.session == SessionState.NONE:
        if action == ActionKind.START_USER_SESSION:
            return "user session is created, empty ops, empty stacks", ["SPEC §3.2"]
        return "throws (no session to act on)", ["SPEC §6 invariants"]

    # USER_ONLY state
    if shape.session == SessionState.USER_ONLY:
        if action == ActionKind.START_USER_SESSION:
            return "throws SessionAlreadyOpenError", ["SPEC §6 invariants"]
        if action == ActionKind.START_COPILOT:
            return "copilot session created, nested in user session", ["SPEC §3.2"]
        if action == ActionKind.USER_PROPOSE:
            return "op added to user session, undo stack grows by one action, redo stack cleared", ["SPEC §3.5"]
        if action == ActionKind.USER_PROPOSE_SAME_PATH:
            if shape.user_op_count == 0:
                return "same as fresh propose (no existing op to shadow)", ["SPEC §3.3"]
            return "new op supersedes existing active op at path (shadow); undo stack grows; redo cleared", ["SPEC §3.3 identity rule"]
        if action == ActionKind.USER_REVERT_TOUCHED:
            if shape.user_op_count == 0:
                return "N/A — no op to revert at any path", []
            return "active op at path removed; if descendants exist, cascaded as one action", ["SPEC §3.9 cascading revert"]
        if action == ActionKind.USER_REVERT_UNTOUCHED:
            return "throws NoOpAtPathError", ["SPEC §6 invariants, DESIGN §7.1"]
        if action == ActionKind.USER_UNDO:
            if shape.user_undo_depth == 0:
                return "no-op (or throws — still undecided; see DESIGN §9.2)", ["DESIGN §9.2"]
            return "most recent action reversed, moved to redo stack", ["SPEC §3.5"]
        if action == ActionKind.USER_REDO:
            if shape.user_redo_depth == 0:
                return "no-op", ["SPEC §3.5"]
            return "most recent undone action replayed, moved back to undo stack", ["SPEC §3.5"]
        if action == ActionKind.USER_COMMIT:
            return "user ops folded into base, session closes", ["SPEC §3.8"]
        if action == ActionKind.USER_DISCARD:
            return "session ops discarded, session closes, base unchanged", ["SPEC §3.8"]

    # USER_AND_COPILOT state
    if shape.session == SessionState.USER_AND_COPILOT:
        if action == ActionKind.START_COPILOT:
            return "throws CopilotAlreadyOpenError", ["SPEC §6 invariants"]
        if action == ActionKind.COPILOT_PROPOSE:
            return "op added to copilot session; if it overlaps user-touched paths, conflictsWithUser flag set on diff entry", ["SPEC §3.7 reverse direction"]
        if action == ActionKind.COPILOT_PROPOSE_CONFLICT_SAME:
            return "copilot op added with conflictsWithUser=true; no auto-resolution (user edited first)", ["SPEC §3.7, DESIGN §6.8"]
        if action == ActionKind.COPILOT_PROPOSE_CONFLICT_ANCESTOR:
            return "copilot op added with conflictsWithUser=true (ancestor of user's edit)", ["SPEC §3.6, DESIGN §6.8"]
        if action == ActionKind.COPILOT_PROPOSE_CONFLICT_DESCENDANT:
            return "copilot op added with conflictsWithUser=true (descendant of user's edit)", ["SPEC §3.6, DESIGN §6.8"]
        if action == ActionKind.COPILOT_APPROVE:
            if shape.copilot_op_count == 0:
                return "throws NoOpAtPathError", ["DESIGN §7.1"]
            return "copilot op folded into user layer as a user-session action (actor stays 'copilot' — DESIGN §9.1); session stays open", ["SPEC §3.7, DESIGN §9.1"]
        if action == ActionKind.COPILOT_DECLINE:
            if shape.copilot_op_count == 0:
                return "throws NoOpAtPathError", ["DESIGN §7.1"]
            return "copilot op dropped; session stays open", ["SPEC §3.7"]
        if action == ActionKind.COPILOT_APPROVE_ALL:
            return "all copilot ops folded into user layer; session ends", ["SPEC §3.7"]
        if action == ActionKind.COPILOT_DECLINE_ALL:
            return "all copilot ops dropped; session ends", ["SPEC §3.7"]
        if action == ActionKind.COPILOT_END:
            return "session ends; any remaining ops effectively dropped", ["SPEC §3.7"]
        if action == ActionKind.COPILOT_UNDO:
            if shape.copilot_undo_depth == 0:
                return "no-op (or throws; see DESIGN §9.2)", ["DESIGN §9.2"]
            return "most recent copilot action reversed (isolated from user stack)", ["SPEC §3.5 per-session stacks"]
        if action == ActionKind.COPILOT_REDO:
            if shape.copilot_redo_depth == 0:
                return "no-op", ["SPEC §3.5"]
            return "most recent undone copilot action replayed", ["SPEC §3.5"]
        if action == ActionKind.USER_EDIT_SAME_AS_COPILOT:
            if shape.copilot_op_count == 0:
                return "regular user propose, no auto-resolution (nothing to resolve against)", ["SPEC §3.5"]
            return "AUTO-DECLINE — copilot op at same path removed; user op lands in user layer", ["SPEC §3.7 Case A, DESIGN §6.3"]
        if action == ActionKind.USER_EDIT_DESCENDANT_OF_COPILOT:
            if shape.copilot_op_count == 0:
                return "regular user propose, no auto-resolution", ["SPEC §3.5"]
            return "AUTO-ACCEPT — copilot ancestor op folded into user layer as one action; user's descendant op lands as next action", ["SPEC §3.7 Case B, DESIGN §6.4"]
        if action == ActionKind.USER_EDIT_ANCESTOR_OF_COPILOT:
            if shape.copilot_op_count == 0:
                return "regular user propose, no auto-resolution", ["SPEC §3.5"]
            return "AUTO-DECLINE WITH CASCADE — all copilot ops within subtree removed; user op lands", ["SPEC §3.7 Case C, DESIGN §6.5"]
        if action == ActionKind.USER_EDIT_UNRELATED:
            return "regular user propose; copilot ops untouched; no conflict flag", ["SPEC §3.7 Case D, DESIGN §6.6"]

    return "UNSPECIFIED — potential gap in spec", ["TODO"]


def generate_scenarios() -> list[Scenario]:
    shapes = enumerate_state_shapes()
    scenarios = []
    counter = 0

    for shape in shapes:
        applicable_actions = ACTIONS_BY_SESSION[shape.session]
        # Filter out actions that require specific preconditions not met by this shape
        for action in applicable_actions:
            # Skip actions that are only meaningful in specific state configurations
            if action == ActionKind.USER_PROPOSE_SAME_PATH and shape.user_op_count == 0:
                continue  # Covered by USER_PROPOSE
            if action in (ActionKind.USER_EDIT_SAME_AS_COPILOT,
                          ActionKind.USER_EDIT_DESCENDANT_OF_COPILOT,
                          ActionKind.USER_EDIT_ANCESTOR_OF_COPILOT) and shape.copilot_op_count == 0:
                continue  # Needs a copilot op to relate to
            if action == ActionKind.USER_REDO and shape.user_redo_depth == 0 and shape.user_undo_depth == 0:
                continue  # Boring empty-stack case, covered elsewhere
            if action == ActionKind.COPILOT_REDO and shape.copilot_redo_depth == 0:
                continue

            counter += 1
            behavior, rules = predict_behavior(shape, action)
            scenarios.append(Scenario(
                id=f"GEN-{counter:04d}",
                state_shape=shape,
                action=action,
                expected_behavior=behavior,
                covers_rule=rules,
            ))

    return scenarios


# ---------------------------------------------------------------------------
# Coverage analysis
# ---------------------------------------------------------------------------

def analyze_coverage(scenarios: list[Scenario]) -> dict:
    """Summarize what's covered, what's not, and where gaps are."""
    by_action = {}
    by_session = {}
    unspecified = []

    for s in scenarios:
        by_action.setdefault(s.action, 0)
        by_action[s.action] += 1
        by_session.setdefault(s.state_shape.session, 0)
        by_session[s.state_shape.session] += 1
        if "UNSPECIFIED" in s.expected_behavior:
            unspecified.append(s)

    return {
        "total": len(scenarios),
        "by_action": {a.name: c for a, c in by_action.items()},
        "by_session": {s.value: c for s, c in by_session.items()},
        "unspecified_count": len(unspecified),
        "unspecified": unspecified,
    }


# ---------------------------------------------------------------------------
# Cross-reference against hand-written SCENARIOS.md
# ---------------------------------------------------------------------------

# Mapping: which hand-written scenario IDs exercise which (session, action)?
# This is maintained by hand. Update whenever SCENARIOS.md changes.
HAND_WRITTEN_COVERAGE: dict[str, tuple[SessionState, Optional[ActionKind]]] = {
    'BASIC-02': (SessionState.NONE, ActionKind.START_USER_SESSION),
    'BASIC-03': (SessionState.USER_ONLY, ActionKind.START_USER_SESSION),
    'BASIC-04': (SessionState.USER_ONLY, ActionKind.USER_PROPOSE),
    'BASIC-05': (SessionState.USER_ONLY, ActionKind.USER_COMMIT),
    'BASIC-06': (SessionState.USER_ONLY, ActionKind.USER_DISCARD),
    'BASIC-07': (SessionState.USER_ONLY, ActionKind.USER_PROPOSE),
    'IDENTITY-01': (SessionState.USER_ONLY, ActionKind.USER_PROPOSE_SAME_PATH),
    'IDENTITY-02': (SessionState.USER_ONLY, ActionKind.USER_REVERT_TOUCHED),
    'IDENTITY-03': (SessionState.USER_ONLY, ActionKind.USER_UNDO),
    'UNDO-01': (SessionState.USER_ONLY, ActionKind.USER_UNDO),
    'UNDO-02': (SessionState.USER_ONLY, ActionKind.USER_REDO),
    'UNDO-03': (SessionState.USER_ONLY, ActionKind.USER_PROPOSE),
    'UNDO-04': (SessionState.USER_ONLY, ActionKind.USER_UNDO),
    'UNDO-05': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_UNDO),
    'CASCADE-01': (SessionState.USER_ONLY, ActionKind.USER_REVERT_TOUCHED),
    'CASCADE-02': (SessionState.USER_ONLY, ActionKind.USER_UNDO),
    'CASCADE-03': (SessionState.USER_ONLY, ActionKind.USER_REDO),
    'CASCADE-04': (SessionState.USER_ONLY, ActionKind.USER_REVERT_TOUCHED),
    'CASCADE-05': (SessionState.USER_ONLY, ActionKind.USER_REVERT_UNTOUCHED),
    'CASCADE-06': (SessionState.USER_ONLY, ActionKind.USER_REVERT_TOUCHED),
    'CASCADE-07': (SessionState.USER_ONLY, ActionKind.USER_REVERT_TOUCHED),
    'COPILOT-01': (SessionState.USER_ONLY, ActionKind.START_COPILOT),
    'COPILOT-03': (SessionState.USER_AND_COPILOT, ActionKind.START_COPILOT),
    'COPILOT-04': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_APPROVE),
    'COPILOT-05': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_DECLINE),
    'COPILOT-06': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_APPROVE),
    'COPILOT-07': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_APPROVE_ALL),
    'COPILOT-08': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_DECLINE_ALL),
    'COPILOT-09': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_END),
    'COPILOT-10': (SessionState.USER_ONLY, ActionKind.START_COPILOT),
    'KING-01': (SessionState.USER_AND_COPILOT, ActionKind.USER_EDIT_SAME_AS_COPILOT),
    'KING-02': (SessionState.USER_AND_COPILOT, ActionKind.USER_EDIT_DESCENDANT_OF_COPILOT),
    'KING-03': (SessionState.USER_ONLY, ActionKind.USER_UNDO),
    'KING-04': (SessionState.USER_ONLY, ActionKind.USER_UNDO),
    'KING-05': (SessionState.USER_ONLY, ActionKind.USER_REVERT_TOUCHED),
    'KING-06': (SessionState.USER_AND_COPILOT, ActionKind.USER_EDIT_ANCESTOR_OF_COPILOT),
    'KING-07': (SessionState.USER_AND_COPILOT, ActionKind.USER_EDIT_ANCESTOR_OF_COPILOT),
    'KING-08': (SessionState.USER_AND_COPILOT, ActionKind.USER_EDIT_UNRELATED),
    'CONFLICT-01': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_PROPOSE_CONFLICT_SAME),
    'CONFLICT-02': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_APPROVE),
    'CONFLICT-03': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_DECLINE),
    'CONFLICT-04': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_PROPOSE_CONFLICT_ANCESTOR),
    'CONFLICT-05': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_PROPOSE_CONFLICT_DESCENDANT),
    'CONFLICT-06': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_PROPOSE),
    'DIFF-02': (SessionState.USER_ONLY, ActionKind.USER_PROPOSE),
    'DIFF-03': (SessionState.USER_ONLY, ActionKind.USER_PROPOSE),
    'DIFF-04': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_PROPOSE),
    'COMMIT-01': (SessionState.USER_AND_COPILOT, ActionKind.USER_COMMIT),
    'COMMIT-02': (SessionState.USER_ONLY, ActionKind.USER_COMMIT),
    'COMMIT-03': (SessionState.USER_ONLY, ActionKind.USER_COMMIT),
    'COMMIT-04': (SessionState.USER_ONLY, ActionKind.USER_DISCARD),
    'INTERACT-01': (SessionState.USER_ONLY, ActionKind.USER_COMMIT),
    'INTERACT-02': (SessionState.USER_ONLY, ActionKind.USER_REVERT_TOUCHED),
    'INTERACT-03': (SessionState.USER_ONLY, ActionKind.USER_UNDO),
    'INTERACT-04': (SessionState.USER_AND_COPILOT, ActionKind.USER_EDIT_SAME_AS_COPILOT),
    'ERROR-01': (SessionState.USER_ONLY, ActionKind.USER_PROPOSE),
    'ERROR-02': (SessionState.USER_ONLY, ActionKind.USER_PROPOSE),
    'ERROR-03': (SessionState.USER_ONLY, ActionKind.USER_PROPOSE),
    'ERROR-04': (SessionState.USER_AND_COPILOT, ActionKind.COPILOT_APPROVE),
}


def cross_reference_coverage(scenarios: list[Scenario]) -> dict:
    """Report how many generated shape/action combinations have
    a hand-written counterpart covering the same (session, action) pair.
    """
    covered_pairs: set[tuple[SessionState, ActionKind]] = set()
    hw_action_counts: dict[ActionKind, int] = {}
    for sid, (sess, act) in HAND_WRITTEN_COVERAGE.items():
        if act is not None:
            covered_pairs.add((sess, act))
            hw_action_counts.setdefault(act, 0)
            hw_action_counts[act] += 1

    # How many distinct state shapes does each action get exercised in by the generator?
    shapes_per_action: dict[ActionKind, set] = {}
    for s in scenarios:
        shapes_per_action.setdefault(s.action, set()).add(s.state_shape)

    # A "covered combination" is one where the hand-written set exercises this action
    # at least once in the same session state. The remaining generator shape variants
    # for that action are "shape-variant gaps" — same action, different state shape.
    by_action_report = {}
    total_gen = 0
    total_hw_touches = 0
    for action, shapes in shapes_per_action.items():
        gen_count = len(shapes)
        hw_count = hw_action_counts.get(action, 0)
        total_gen += gen_count
        total_hw_touches += hw_count
        by_action_report[action.name] = {
            "generator_shapes": gen_count,
            "hand_written_scenarios": hw_count,
            "shape_variant_gap": max(0, gen_count - hw_count),
        }

    return {
        "total_generated_combinations": total_gen,
        "total_hand_written_scenarios": len(HAND_WRITTEN_COVERAGE),
        "total_hand_written_action_touches": total_hw_touches,
        "total_shape_variant_gap": max(0, total_gen - total_hw_touches),
        "by_action": by_action_report,
    }


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def write_output(scenarios: list[Scenario], coverage: dict, path: str):
    with open(path, "w") as f:
        f.write("# Generated Scenarios\n\n")
        f.write("*Auto-generated by `scenario_generator.py`. Do not edit by hand.*\n\n")
        f.write("This file enumerates `(state shape, action)` combinations\n")
        f.write("and predicts engine behavior according to the rules encoded\n")
        f.write("in the generator. It is complementary to the hand-written\n")
        f.write("`SCENARIOS.md` — use it to find coverage gaps.\n\n")

        f.write("## Coverage summary\n\n")
        f.write(f"- Total scenarios: {coverage['total']}\n")
        f.write(f"- Unspecified (potential spec gaps): {coverage['unspecified_count']}\n\n")

        f.write("### By session state\n\n")
        for k, v in sorted(coverage["by_session"].items()):
            f.write(f"- {k}: {v}\n")
        f.write("\n")

        f.write("### By action\n\n")
        for k, v in sorted(coverage["by_action"].items(), key=lambda x: -x[1]):
            f.write(f"- `{k}`: {v}\n")
        f.write("\n")

        if coverage["unspecified"]:
            f.write("## Potential spec gaps\n\n")
            f.write("These `(state, action)` pairs did not match any rule in the generator.\n")
            f.write("Either the spec doesn't say what should happen, or the generator is\n")
            f.write("missing the rule. Either way — investigate.\n\n")
            for s in coverage["unspecified"]:
                f.write(s.render())
            f.write("\n---\n\n")

        f.write("## All generated scenarios\n\n")
        by_action_grouped = {}
        for s in scenarios:
            by_action_grouped.setdefault(s.action, []).append(s)

        for action, items in sorted(by_action_grouped.items(), key=lambda x: x[0].name):
            f.write(f"### Action: `{action.value}`\n\n")
            f.write(f"_{len(items)} scenarios_\n\n")
            for s in items:
                f.write(s.render())
            f.write("\n")


if __name__ == "__main__":
    scenarios = generate_scenarios()
    coverage = analyze_coverage(scenarios)
    xref = cross_reference_coverage(scenarios)
    write_output(scenarios, coverage, "/mnt/user-data/outputs/GENERATED_SCENARIOS.md")
    print(f"Generated {coverage['total']} scenarios.")
    print(f"Session states covered: {coverage['by_session']}")
    print(f"Potential spec gaps (UNSPECIFIED): {coverage['unspecified_count']}")
    print()
    print("=" * 70)
    print("COVERAGE AGAINST HAND-WRITTEN SCENARIOS.md")
    print("=" * 70)
    print(f"Hand-written scenarios:                    {xref['total_hand_written_scenarios']}")
    print(f"Hand-written action touches:               {xref['total_hand_written_action_touches']}")
    print(f"Generated combinations (shape × action):   {xref['total_generated_combinations']}")
    print(f"Shape-variant gap (combinations untested): {xref['total_shape_variant_gap']}")
    print()
    print(f"{'ACTION':<45} {'HW':>4} {'GEN':>4} {'GAP':>4}")
    print("-" * 65)
    for name, rep in sorted(xref["by_action"].items(),
                            key=lambda x: -x[1]["shape_variant_gap"]):
        print(f"{name:<45} {rep['hand_written_scenarios']:>4} {rep['generator_shapes']:>4} {rep['shape_variant_gap']:>4}")
