# Upstream Merge Feasibility — What's Safe to Pull
Fork: ccomcorp/hermes-agent (aios)  |  Upstream: NousResearch/hermes-agent (main)
Divergence base: d1383a6b1  |  Gap: 1,495 commits (1,334 non-merge + 161 merge)

## THE CORE FINDING
The fork's customization touches 110 files, but only **19 are SHARED with upstream**
(the rest are NEW fork-only files upstream can't conflict on). Cross-referencing all
1,334 non-merge upstream commits against those 19 shared files:

  - 1,160 commits (87%)  SAFE   — touch ZERO fork-customized files → merge cleanly
  -   174 commits (13%)  REVIEW — touch a shared file → need manual conflict judgment

## WHY THE RISK IS LOWER THAN IT LOOKS
The fork's edits to shared files are almost purely ADDITIVE (insertions, ~0 deletions):
  background_review.py +211/-0 | memory_manager.py +171/-0 | memory_provider.py +60/-0
  desktop-controller.tsx +90/-0 | delegate_tool.py +60/-1 | main.py +33/-0
This is the seam/hook pattern: we ADDED code, rarely rewrote upstream lines. Git's 3-way
merge resolves cleanly except at the exact insertion points → most of the 174 are
auto-mergeable, with real conflicts concentrated in a handful of hotspots.

## RECOMMENDED STRATEGY: tiered pull, not a big-bang merge

### TIER 1 — Pull now, near-zero risk (1,160 safe commits)
Includes 18 security fixes (path traversal, shell injection, prompt-injection hardening,
secret redaction), 670 bug fixes, 149 features, 93 test additions — none touch fork files.
Mechanism: merge upstream/main; the 1,160 land without touching the AIOS loop.

### TIER 2 — Review the 174 conflict commits, hotspot-first
Conflict concentration (upstream commits per shared file):
   49  hermes_cli/main.py          ← update-path rewrites; OUR safe-update guard lives here
   23  hermes_cli/commands.py
   21  agent/agent_init.py         ← OUR memory-tool injection gate (#5544 interaction)
   17  agent/conversation_loop.py  ← OUR turn-context recall seam
   16  desktop-controller.tsx      ← FRONTEND: our routes/panels
   11  package-lock.json / 11 pyproject.toml  ← dep bumps, mechanical
    9  tools/delegate_tool.py      ← OUR pre-delegation recall seam
    7  memory_manager.py / 7 sidebar.tsx
    6  turn_context.py / 6 background_review.py
These carry upstream features we likely WANT (delegation fan-out, memory batch ops,
background-review aux-model selector) AND collide with our seams. Each needs a human call.

### TIER 3 — Verify after every tier
python scripts/loop_liveness.py   (exit 0 = seams intact)
python -m pytest plugins/memory/composite/tests
Desktop boots without LoopWiringError; npm run build for frontend.

## VERDICT
A full upstream merge is FEASIBLE and most of it (87%) is genuinely safe. The danger is
confined to 19 files / 174 commits, and even there the additive seam pattern keeps real
conflicts to ~8 hotspots. This is a controlled, reviewable session — not a rewrite.
