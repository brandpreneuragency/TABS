#!/bin/sh
# Autonomous gate for the TABS Work-OS harness continuation plan.
#
# Differences from the first run's gate:
#   1. Source failures print an explicit FAILURE_CLASS=SOURCE line. The
#      orchestrator's classify_failure() is patched to honour that line, so a
#      word like "credential" inside a file path can no longer park a phase as
#      an external problem with zero retries.
#   2. Only a real host or preflight prerequisite prints FAILURE_CLASS=EXTERNAL.
#      A missing rustfmt component is one of those; a failed source assertion
#      is not.
#   3. Every work phase must declare commit_files. The gate compares it against
#      the real working tree, and each review gate re-derives its phase's
#      changed paths from that phase's commit, so failed work can no longer
#      ride into a later phase unreviewed.
#
# The gate is sandboxed: only $TMPDIR is writable. It never writes to $RUN_DIR.

set -u

PHASE="${1:?phase name required}"
RUN="${2:?run dir required}"
EVIDENCE="$RUN/$PHASE.txt"
PROBLEMS=""

fail() {
    PROBLEMS="$PROBLEMS- $1
"
}

external() {
    printf 'FAILURE_CLASS=EXTERNAL\n%s\n' "$1"
    # Do not discard source problems already found. The prerequisite is still
    # the blocker, but the worker needs to see everything this run produced.
    if [ -n "$PROBLEMS" ]; then
        printf '\nAlso recorded before the prerequisite stopped this gate:\n%s' "$PROBLEMS"
    fi
    exit 1
}

need_key() {
    grep -qE "^$1=..*" "$EVIDENCE" 2>/dev/null \
        || fail "$PHASE.txt has no '$1=' line with a value. Add the real value."
}

need_value() {
    grep -qxF "$1=$2" "$EVIDENCE" 2>/dev/null \
        || fail "$PHASE.txt must contain '$1=$2'. Correct the work and record the real value."
}

key_value() {
    sed -n "s/^$1=//p" "$EVIDENCE" 2>/dev/null | sed -n '1p'
}

need_file() {
    [ -f "$REPO_DIR/$1" ] || fail "$1 does not exist. Create the required artifact."
}

need_dir() {
    [ -d "$REPO_DIR/$1" ] || fail "$1 does not exist. Create the required directory."
}

need_text() {
    grep -qF "$2" "$REPO_DIR/$1" 2>/dev/null \
        || fail "$1 does not contain '$2'. Implement the required contract."
}

reject_text() {
    if [ -e "$REPO_DIR/$1" ] && grep -qF "$2" "$REPO_DIR/$1" 2>/dev/null; then
        fail "$1 still contains forbidden production text '$2'. Remove that path."
    fi
}

need_test_matching() {
    find "$REPO_DIR/$1" -type f \( -name '*test.ts' -o -name '*test.tsx' \) 2>/dev/null \
        | grep -q . || fail "$1 has no focused test file. Add regression tests."
}

receipt_key() {
    _r="${PLAN_DIR:-}/prelaunch-receipt.json"
    [ -n "${PLAN_DIR:-}" ] && [ -f "$_r" ] \
        || external "manual preflight is not done: prelaunch-receipt.json is missing. Complete PREFLIGHT.md."
    grep -qE "\"$1\"[[:space:]]*:[[:space:]]*(\"[^\"]+\"|[0-9]+|true)" "$_r" \
        || external "manual preflight item '$1' is not recorded in prelaunch-receipt.json."
    # An unedited template value is not a completed preflight item.
    case "$(receipt_value "$1")" in
        TODO*|todo*|'<'*)
            external "manual preflight item '$1' still holds the template placeholder. Complete PREFLIGHT.md and record the real value."
            ;;
    esac
}

receipt_value() {
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" \
        "${PLAN_DIR:-}/prelaunch-receipt.json" 2>/dev/null | sed -n '1p'
}

# ---------------------------------------------------------------------------
# changed-path accounting
# ---------------------------------------------------------------------------

# The gate runs sandboxed: only $TMPDIR is writable, so this section never
# writes into $RUN_DIR. Work phases are gated BEFORE the orchestrator commits,
# so their changes are still in the working tree. Review phases run after that
# commit, so the review gate reads the phase's commit out of Git instead.
# gates/ is excluded everywhere: the gate itself is installed by preflight and
# is not a worker's change to declare.

GIT_RO="git --no-optional-locks"

have_git() {
    command -v git >/dev/null 2>&1 && [ -d "$REPO_DIR/.git" ]
}

worktree_paths_into() {
    have_git || return 1
    (cd "$REPO_DIR" && $GIT_RO status --porcelain=v1 --untracked-files=all 2>/dev/null) \
        | sed -e 's/^...//' -e 's/^.* -> //' -e 's/^"//' -e 's/"$//' \
        | grep -v '^gates/' | sed '/^$/d' | sort -u > "$1"
}

commit_paths_into() {
    # $1 = phase name, $2 = destination file
    have_git || return 1
    _sha=$( (cd "$REPO_DIR" && $GIT_RO log --format='%H%x09%s' -n 80 2>/dev/null) \
        | awk -F'\t' -v want=": $1 (orchestrated)" 'index($2, want) { print $1; exit }' )
    [ -n "$_sha" ] || return 1
    (cd "$REPO_DIR" && $GIT_RO diff --name-only "$_sha^" "$_sha" 2>/dev/null) \
        | grep -v '^gates/' | sed '/^$/d' | sort -u > "$2"
}

check_commit_files() {
    need_key commit_files
    _paths="$TMPDIR/$PHASE-worktree.txt"
    worktree_paths_into "$_paths" || return 0
    DECLARED="$(key_value commit_files | tr -d ' ')"
    MISSING=""
    SEEN=0
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        SEEN=$((SEEN + 1))
        case ",$DECLARED," in
            *",$f,"*) ;;
            *) MISSING="$MISSING $f" ;;
        esac
    done < "$_paths"
    [ -z "$MISSING" ] \
        || fail "commit_files does not name every path this phase changed. Missing:$MISSING"
    # No negative assertion here. The automatic doctor commits with `git add -A`,
    # so on a retry this phase's own work is already in HEAD and the tree is
    # clean while commit_files still correctly names what the phase authored.
    # Failing on that is unrecoverable: the worker can never satisfy it.
}

# ---------------------------------------------------------------------------
# tool runners
# ---------------------------------------------------------------------------

require_frontend_tools() {
    [ -x "$REPO_DIR/node_modules/.bin/vitest" ] \
        && [ -x "$REPO_DIR/node_modules/.bin/tsc" ] \
        || external "frontend dependencies are missing. Run npm install in the target repository."
}

run_typescript() {
    require_frontend_tools
    APP_INFO="$TMPDIR/$PHASE-app.tsbuildinfo"
    NODE_INFO="$TMPDIR/$PHASE-node.tsbuildinfo"
    APP_LOG="$TMPDIR/$PHASE-tsc-app.log"
    NODE_LOG="$TMPDIR/$PHASE-tsc-node.log"
    (cd "$REPO_DIR" && \
        "$REPO_DIR/node_modules/.bin/tsc" -p tsconfig.app.json --noEmit \
            --incremental --tsBuildInfoFile "$APP_INFO") >"$APP_LOG" 2>&1 \
        || fail "TypeScript app check failed. Run the app typecheck and repair every error."
    (cd "$REPO_DIR" && \
        "$REPO_DIR/node_modules/.bin/tsc" -p tsconfig.node.json --noEmit \
            --incremental --tsBuildInfoFile "$NODE_INFO") >"$NODE_LOG" 2>&1 \
        || fail "TypeScript node check failed. Run the node typecheck and repair every error."
}

run_vitest_file() {
    TEST_FILE="$1"
    [ -f "$REPO_DIR/$TEST_FILE" ] || {
        fail "$TEST_FILE does not exist. Add the required focused tests."
        return
    }
    require_frontend_tools
    TEST_LOG="$TMPDIR/$PHASE-vitest.log"
    ATTACHMENTS="$TMPDIR/$PHASE-attachments"
    mkdir -p "$ATTACHMENTS"
    (cd "$REPO_DIR" && \
        HOME="$TMPDIR" XDG_CACHE_HOME="$TMPDIR/cache" npm_config_cache="$TMPDIR/npm-cache" CI=1 \
        "$REPO_DIR/node_modules/.bin/vitest" run "$TEST_FILE" --no-cache \
            --configLoader runner --attachmentsDir "$ATTACHMENTS" --no-color) >"$TEST_LOG" 2>&1 \
        || fail "$TEST_FILE failed. Run that focused test and repair every failure."
}

run_vitest_all() {
    require_frontend_tools
    TEST_LOG="$TMPDIR/$PHASE-vitest-all.log"
    ATTACHMENTS="$TMPDIR/$PHASE-all-attachments"
    mkdir -p "$ATTACHMENTS"
    (cd "$REPO_DIR" && \
        HOME="$TMPDIR" XDG_CACHE_HOME="$TMPDIR/cache" npm_config_cache="$TMPDIR/npm-cache" CI=1 \
        "$REPO_DIR/node_modules/.bin/vitest" run --no-cache \
            --configLoader runner --attachmentsDir "$ATTACHMENTS" --no-color) >"$TEST_LOG" 2>&1 \
        || fail "The full Vitest suite failed. Run npm test and repair every failure."
}

run_eslint() {
    [ -x "$REPO_DIR/node_modules/.bin/eslint" ] \
        || external "ESLint is missing. Run npm install in the target repository."
    LINT_LOG="$TMPDIR/$PHASE-eslint.log"
    (cd "$REPO_DIR" && "$REPO_DIR/node_modules/.bin/eslint" . --no-cache --no-color) \
        >"$LINT_LOG" 2>&1 \
        || fail "ESLint failed. Run npm run lint and repair every error."
}

run_vite_build() {
    [ -x "$REPO_DIR/node_modules/.bin/vite" ] \
        || external "Vite is missing. Run npm install in the target repository."
    BUILD_LOG="$TMPDIR/$PHASE-vite.log"
    BUILD_OUT="$TMPDIR/$PHASE-dist"
    (cd "$REPO_DIR" && \
        HOME="$TMPDIR" XDG_CACHE_HOME="$TMPDIR/cache" npm_config_cache="$TMPDIR/npm-cache" CI=1 \
        "$REPO_DIR/node_modules/.bin/vite" build --configLoader runner \
            --outDir "$BUILD_OUT" --emptyOutDir) >"$BUILD_LOG" 2>&1 \
        || fail "The Vite production build failed. Run npm run build and repair every error."
}

run_cargo() {
    command -v cargo >/dev/null 2>&1 \
        || external "Cargo is unavailable. Complete the VPS toolchain preflight."
    # Root blocker 2 of the first run: the gate could not run Rust formatting
    # because the rustfmt component was absent. That is a host prerequisite and
    # the owner installs it before launch. Workers never install toolchains.
    receipt_key rustfmt_installed
    (cd "$REPO_DIR/src-tauri" && cargo fmt --version) >/dev/null 2>&1 \
        || external "the rustfmt component is not installed for the active toolchain. The owner must run: rustup component add rustfmt --toolchain stable-x86_64-unknown-linux-gnu"
    [ -f "$REPO_DIR/src-tauri/Cargo.lock" ] \
        || external "src-tauri/Cargo.lock is missing. The autonomous gate requires locked Rust dependencies."
    CARGO_LOG="$TMPDIR/$PHASE-cargo.log"
    (cd "$REPO_DIR/src-tauri" && cargo fmt --check) >"$CARGO_LOG" 2>&1 \
        || fail "Rust formatting failed. Run cargo fmt and inspect the intended changes."
    (cd "$REPO_DIR/src-tauri" && \
        CARGO_TARGET_DIR="$TMPDIR/cargo-target" cargo check --locked --offline) \
        >>"$CARGO_LOG" 2>&1 \
        || fail "Rust compile check failed. Run cargo check and repair every error."
    (cd "$REPO_DIR/src-tauri" && \
        CARGO_TARGET_DIR="$TMPDIR/cargo-target" cargo test --locked --offline) \
        >>"$CARGO_LOG" 2>&1 \
        || fail "Rust tests failed. Run cargo test and repair every failure."
}

report() {
    if [ -z "$PROBLEMS" ]; then
        exit 0
    fi
    printf 'FAILURE_CLASS=SOURCE\n'
    printf 'Phase %s did not pass. Repair every item, then rewrite %s.txt.\n\n%s' \
        "$PHASE" "$PHASE" "$PROBLEMS"
    exit 1
}

primary_artifact() {
    case "$1" in
        baseline-audit) printf '%s' 'TABS_WORK_OS_HARNESS_PLAN.md' ;;
        recover-secure-storage-migration) printf '%s' 'src/services/agent/credentialMigration.ts' ;;
        recover-native-workspace-scope) printf '%s' 'src-tauri/src/agent_tools/scope.rs' ;;
        recover-task-projection) printf '%s' 'src/services/tasks/taskProjectionWorker.ts' ;;
        document-commands) printf '%s' 'src/services/documents/documentCommands.ts' ;;
        provider-adapter) printf '%s' 'src/services/agent/providers/openAICompatibleAdapter.ts' ;;
        runtime-kernel) printf '%s' 'src/services/agent/runExecutor.ts' ;;
        tool-policy-approvals) printf '%s' 'src/services/agent/policyEngine.ts' ;;
        read-tools-context) printf '%s' 'src/services/agent/contextManager.ts' ;;
        mutation-tools) printf '%s' 'src/services/agent/tools/taskTools.ts' ;;
        golden-evaluations) printf '%s' 'src/services/agent/evals/goldenWorkflow.test.ts' ;;
        scheduler-recovery) printf '%s' 'src/services/agent/agentScheduler.ts' ;;
        desktop-lifecycle) printf '%s' 'src-tauri/src/commands/lifecycle.rs' ;;
        harness-ui) printf '%s' 'src/components/agent/AgentSidebar.tsx' ;;
        prompt-profiles-compaction) printf '%s' 'src/services/agent/promptCompiler.ts' ;;
        coding-web-hardening) printf '%s' 'src/services/agent/tools/fileTools.ts' ;;
        cutover-release) printf '%s' 'src/services/db.ts' ;;
        *) printf '%s' '' ;;
    esac
}

test_artifact() {
    case "$1" in
        baseline-audit) printf '%s' '' ;;
        recover-secure-storage-migration) printf '%s' 'src/services/agent/credentialMigration.test.ts' ;;
        recover-native-workspace-scope) printf '%s' 'src/services/agent/tools/nativeScopeAdapter.test.ts' ;;
        recover-task-projection) printf '%s' 'src/services/tasks/taskProjectionWorker.test.ts' ;;
        document-commands) printf '%s' 'src/services/documents/documentCommands.test.ts' ;;
        provider-adapter) printf '%s' 'src/services/agent/providers/openAICompatibleAdapter.test.ts' ;;
        runtime-kernel) printf '%s' 'src/services/agent/runExecutor.test.ts' ;;
        tool-policy-approvals) printf '%s' 'src/services/agent/policyEngine.test.ts' ;;
        read-tools-context) printf '%s' 'src/services/agent/tools/readTools.test.ts' ;;
        mutation-tools) printf '%s' 'src/services/agent/tools/mutationTools.test.ts' ;;
        golden-evaluations) printf '%s' 'src/services/agent/evals/goldenWorkflow.test.ts' ;;
        scheduler-recovery) printf '%s' 'src/services/agent/agentScheduler.test.ts' ;;
        desktop-lifecycle) printf '%s' 'src/services/agent/lifecycle/desktopLifecycleAdapter.test.ts' ;;
        harness-ui) printf '%s' 'src/components/agent/AgentSidebar.test.tsx' ;;
        prompt-profiles-compaction) printf '%s' 'src/services/agent/promptCompiler.test.ts' ;;
        coding-web-hardening) printf '%s' 'src/services/agent/tools/codingTools.test.ts' ;;
        cutover-release) printf '%s' 'src/services/agent/evals/goldenWorkflow.test.ts' ;;
        *) printf '%s' '' ;;
    esac
}

review_gate() {
    WORK="${PHASE#review-}"
    WORK_EVIDENCE="$RUN/$WORK.txt"
    [ -f "$WORK_EVIDENCE" ] \
        || fail "$WORK.txt is not visible to the review gate. Review the paired work evidence."
    need_value verdict PASS
    need_value findings none
    need_key work_sha256
    need_key files_reviewed
    need_key tests_reviewed
    need_key diff_reviewed

    if ! command -v sha256sum >/dev/null 2>&1; then
        external "sha256sum is unavailable on the orchestrator host."
    elif [ -f "$WORK_EVIDENCE" ]; then
        EXPECTED="$(sha256sum "$WORK_EVIDENCE" | awk '{print $1}')"
        ACTUAL="$(key_value work_sha256)"
        [ "$ACTUAL" = "$EXPECTED" ] \
            || fail "work_sha256 does not match $WORK.txt. Read the paired evidence before reviewing."
    fi

    # The review must have looked at every path the work phase really changed.
    # By review time the orchestrator has committed that phase, so Git is the
    # authority -- not anything the worker or a previous gate wrote down.
    _wp="$TMPDIR/$PHASE-workpaths.txt"
    if commit_paths_into "$WORK" "$_wp" && [ -s "$_wp" ]; then
        REVIEWED="$(key_value diff_reviewed)$(key_value files_reviewed)"
        UNSEEN=""
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            case "$REVIEWED" in
                *"$f"*) ;;
                *) UNSEEN="$UNSEEN $f" ;;
            esac
        done < "$_wp"
        [ -z "$UNSEEN" ] \
            || fail "diff_reviewed omits paths the paired phase changed. Read and name:$UNSEEN"
    fi

    PRIMARY="$(primary_artifact "$WORK")"
    if [ -z "$PRIMARY" ]; then
        fail "the gate has no primary artifact mapping for $WORK. This is a plan fault."
    else
        [ -f "$REPO_DIR/$PRIMARY" ] \
            || fail "the review says PASS, but $PRIMARY does not exist."
        grep -qF "$PRIMARY" "$EVIDENCE" 2>/dev/null \
            || fail "files_reviewed must name $PRIMARY. Read the primary artifact."
    fi

    REVIEW_TEST="$(test_artifact "$WORK")"
    if [ -n "$REVIEW_TEST" ]; then
        grep -qF "$REVIEW_TEST" "$EVIDENCE" 2>/dev/null \
            || fail "tests_reviewed must name $REVIEW_TEST and its real result."
    fi
}

[ -f "$EVIDENCE" ] || fail "the evidence file $PHASE.txt was not written to \$RUN_DIR"

case "$PHASE" in
    review-*)
        review_gate
        ;;

    baseline-audit)
        receipt_key gate_installed
        receipt_key baseline_commit
        receipt_key models_verified
        receipt_key rustfmt_installed
        receipt_key toolchain_verified
        [ -f "$REPO_DIR/TABS_WORK_OS_HARNESS_PLAN.md" ] \
            || external "TABS_WORK_OS_HARNESS_PLAN.md is not in the target checkout. Publish the approved baseline."
        need_key baseline_commit
        need_key accepted_phases
        need_key accepted_artifacts
        need_key unreviewed_paths
        need_key typecheck
        need_value typecheck_exit 0
        EXPECTED_BASE="$(receipt_value baseline_commit)"
        ACTUAL_BASE="$(key_value baseline_commit)"
        [ -n "$EXPECTED_BASE" ] && [ "$ACTUAL_BASE" = "$EXPECTED_BASE" ] \
            || fail "baseline_commit must equal the prelaunch receipt value '$EXPECTED_BASE'. Read the receipt."
        # This phase audits. It must not change the repository.
        for p in src/types/agent.ts src/services/db.ts src/data/crmFormsDb.ts \
                 src/services/agent/runRepository.ts src/services/agent/artifactStore.ts \
                 src/services/agent/runStateMachine.ts src/services/agent/agentClient.ts \
                 src/services/tasks/taskService.ts src/services/submissionService.ts; do
            [ -f "$REPO_DIR/$p" ] || fail "$p does not exist. The accepted baseline is not present in this checkout."
        done
        need_dir src/services/agent
        ;;

    recover-secure-storage-migration)
        receipt_key baseline_commit
        need_file src/services/agent/credentialMigration.ts
        need_file src/services/agent/credentialMigration.test.ts
        need_text src/services/agent/credentialMigration.ts secure
        need_text src/services/agent/credentialMigration.ts migration
        need_key audit_result
        need_key migration_marker
        need_key stored_kinds
        need_key deletion_rule
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    recover-native-workspace-scope)
        receipt_key baseline_commit
        receipt_key rustfmt_installed
        need_file src-tauri/src/agent_tools/scope.rs
        need_file src/services/agent/tools/nativeScopeAdapter.ts
        need_text src-tauri/src/agent_tools/scope.rs canonical
        need_text src-tauri/src/lib.rs scope
        need_key audit_result
        need_key rust_commands
        need_key scope_invariants
        need_key escape_cases
        need_key rust_test
        need_value rust_test_exit 0
        ;;

    recover-task-projection)
        receipt_key baseline_commit
        receipt_key rustfmt_installed
        need_file src/services/tasks/taskProjectionWorker.ts
        need_text src/services/tasks/taskProjectionWorker.ts superseded
        need_text src/services/tasks/taskProjectionWorker.ts sourceOperationId
        grep -R -qF 'app_local_data_dir' "$REPO_DIR/src-tauri/src" 2>/dev/null \
            || fail "Rust projection code does not derive the app-local data directory."
        need_key audit_result
        need_key projection_states
        need_key root_rule
        need_key retry_rule
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    document-commands)
        need_file src/services/documents/documentCommands.ts
        need_file src/services/domainEvents.ts
        need_text src/services/documents/documentCommands.ts expected
        need_text src/services/documents/documentCommands.ts revision
        need_key commands
        need_key revision_scheme
        need_key conflict_cases
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    provider-adapter)
        need_file src/services/agent/providers/providerAdapter.ts
        need_file src/services/agent/providers/openAICompatibleAdapter.ts
        need_file src/services/agent/providers/fakeProvider.ts
        need_text src/services/agent/providers/openAICompatibleAdapter.ts tool_calls
        need_text src/services/agent/providers/openAICompatibleAdapter.ts tool_call_id
        need_key adapter_contract
        need_key protocol_fields
        need_key retry_cases
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    runtime-kernel)
        need_file src/services/agent/agentRuntime.ts
        need_file src/services/agent/runExecutor.ts
        reject_text src/services/agent/agentRuntime.ts "from 'react'"
        reject_text src/services/agent/runExecutor.ts "from 'react'"
        reject_text src/services/agent/runExecutor.ts useStore
        need_key runtime_boundaries
        need_key turn_rules
        need_key cancellation_cases
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    tool-policy-approvals)
        need_file src/services/agent/toolRegistry.ts
        need_file src/services/agent/policyEngine.ts
        need_text src/services/agent/policyEngine.ts resourceRevisions
        need_text src/services/agent/policyEngine.ts commandDigest
        need_key registered_tools
        need_key policy_order
        need_key grant_constraints
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    read-tools-context)
        need_file src/services/agent/contextManager.ts
        need_file src/services/agent/tools/documentTools.ts
        need_file src/services/agent/tools/taskTools.ts
        need_file src/services/agent/tools/crmTools.ts
        need_file src/services/agent/tools/formTools.ts
        need_key read_tools
        need_key context_kinds
        need_key result_limits
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    mutation-tools)
        need_file src/services/agent/tools/documentTools.ts
        need_file src/services/agent/tools/taskTools.ts
        need_file src/services/agent/tools/crmTools.ts
        grep -R -qF 'effectFingerprint' "$REPO_DIR/src/services/agent" 2>/dev/null \
            || fail "Mutation tools contain no effect fingerprint implementation."
        need_key mutation_tools
        need_key effect_fields
        need_key recovery_rules
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    golden-evaluations)
        need_file src/services/agent/evals/goldenWorkflow.test.ts
        need_text package.json test:agent-evals
        need_value golden_runs 10
        need_key fault_points
        need_key expected_mutations
        need_key eval_command
        need_value eval_exit 0
        ;;

    scheduler-recovery)
        need_file src/services/agent/agentScheduler.ts
        need_file src/services/agent/recoveryManager.ts
        need_file src/services/agent/startupBarrier.ts
        need_text src/services/agent/agentScheduler.ts 15000
        need_text src/services/agent/agentScheduler.ts 5000
        need_key scheduler_order
        need_key lease_values
        need_key recovery_matrix
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    desktop-lifecycle)
        need_file src-tauri/src/commands/lifecycle.rs
        need_file src/services/agent/lifecycle/desktopLifecycleAdapter.ts
        need_text src-tauri/src/commands/lifecycle.rs complete_shutdown
        grep -qF 'tabs://shutdown-requested' "$REPO_DIR/src-tauri/src/tray.rs" 2>/dev/null \
            || fail "tray.rs does not emit tabs://shutdown-requested."
        need_key lifecycle_commands
        need_key startup_order
        need_key quit_outcomes
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    harness-ui)
        need_file src/components/agent/AgentSidebar.tsx
        need_file src/components/agent/RunCenter.tsx
        need_file src/components/agent/RunTimeline.tsx
        need_file src/components/agent/ApprovalCard.tsx
        need_file src/stores/agentUiStore.ts
        need_key components
        need_key client_actions
        need_key i18n_keys
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    prompt-profiles-compaction)
        need_file src/services/agent/promptCompiler.ts
        need_file src/services/agent/skillLoader.ts
        need_text src/services/agent/promptCompiler.ts AGENTS.md
        grep -R -qF 'compact' "$REPO_DIR/src/services/agent" 2>/dev/null \
            || fail "Agent services contain no context compaction implementation."
        need_key prompt_order
        need_key initial_profiles
        need_key budget_rule
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    coding-web-hardening)
        need_file src/services/agent/tools/fileTools.ts
        need_file src/services/agent/tools/shellTools.ts
        need_file src/services/agent/tools/webTools.ts
        need_text src-tauri/capabilities/default.json http:default
        need_text src-tauri/tauri.conf.json frame-src
        need_key coding_tools
        need_key native_limits
        need_key capability_changes
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    cutover-release)
        need_text src/services/db.ts 'version(14)'
        [ ! -e "$REPO_DIR/src/hooks/useAgentLoop.ts" ] \
            || fail "src/hooks/useAgentLoop.ts still exists. Remove the old production loop."
        [ ! -e "$REPO_DIR/src/stores/taskAIStore.ts" ] \
            || fail "src/stores/taskAIStore.ts still exists. Remove the dormant task AI store."
        grep -R -qF 'AgentSidebar' "$REPO_DIR/src" 2>/dev/null \
            || fail "The production app does not mount the new AgentSidebar."
        need_key removed_paths
        need_key version14_tables
        need_key preserved_settings
        need_key full_check
        need_value full_check_exit 0
        ;;

    *)
        fail "gates/gate.sh has no case for '$PHASE'. This is a plan fault."
        ;;
esac

# Work phases must account for every path they changed.
case "$PHASE" in
    review-*) ;;
    *) check_commit_files ;;
esac

BASE_PHASE="${PHASE#review-}"
if [ "$BASE_PHASE" = "cutover-release" ]; then
    run_typescript
    run_eslint
    run_vitest_all
    run_vite_build
else
    TEST_FILE="$(test_artifact "$BASE_PHASE")"
    if [ -n "$TEST_FILE" ]; then
        run_vitest_file "$TEST_FILE"
    fi
    run_typescript
fi

case "$BASE_PHASE" in
    recover-native-workspace-scope|recover-task-projection|desktop-lifecycle|coding-web-hardening|cutover-release)
        run_cargo
        ;;
esac

report
