#!/bin/sh
# Autonomous gate for the TABS Work-OS harness plan.

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
    find "$REPO_DIR/$1" -type f -name '*test.ts' -o -name '*test.tsx' 2>/dev/null \
        | grep -q . || fail "$1 has no focused test file. Add regression tests."
}

receipt_key() {
    _r="${PLAN_DIR:-}/prelaunch-receipt.json"
    [ -n "${PLAN_DIR:-}" ] && [ -f "$_r" ] \
        || external "manual preflight is not done: prelaunch-receipt.json is missing. Complete PREFLIGHT.md."
    grep -qE "\"$1\"[[:space:]]*:[[:space:]]*(\"[^\"]+\"|[0-9]+|true)" "$_r" \
        || external "manual preflight item '$1' is not recorded in prelaunch-receipt.json."
}

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
    printf 'Phase %s did not pass. Repair every item, then rewrite %s.txt.\n\n%s' \
        "$PHASE" "$PHASE" "$PROBLEMS"
    exit 1
}

primary_artifact() {
    case "$1" in
        contracts-baseline) printf '%s' 'src/types/agent.ts' ;;
        persistence-schema) printf '%s' 'src/services/db.ts' ;;
        credential-migrations) printf '%s' 'src/services/agent/credentialMigration.ts' ;;
        run-repository) printf '%s' 'src/services/agent/runRepository.ts' ;;
        state-machine-client) printf '%s' 'src/services/agent/runStateMachine.ts' ;;
        native-workspace-scope) printf '%s' 'src-tauri/src/agent_tools/scope.rs' ;;
        document-commands) printf '%s' 'src/services/documents/documentCommands.ts' ;;
        task-service) printf '%s' 'src/services/tasks/taskService.ts' ;;
        task-projection) printf '%s' 'src/services/tasks/taskProjectionWorker.ts' ;;
        crm-forms-commands) printf '%s' 'src/services/submissionService.ts' ;;
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
        contracts-baseline) printf '%s' 'src/services/agent/contracts.test.ts' ;;
        persistence-schema) printf '%s' 'src/services/agent/persistenceMigrations.test.ts' ;;
        credential-migrations) printf '%s' 'src/services/agent/credentialMigration.test.ts' ;;
        run-repository) printf '%s' 'src/services/agent/runRepository.test.ts' ;;
        state-machine-client) printf '%s' 'src/services/agent/runStateMachine.test.ts' ;;
        native-workspace-scope) printf '%s' 'src/services/agent/tools/nativeScopeAdapter.test.ts' ;;
        document-commands) printf '%s' 'src/services/documents/documentCommands.test.ts' ;;
        task-service) printf '%s' 'src/services/tasks/taskService.test.ts' ;;
        task-projection) printf '%s' 'src/services/tasks/taskProjectionWorker.test.ts' ;;
        crm-forms-commands) printf '%s' 'src/services/crmFormsHarness.test.ts' ;;
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

    if ! command -v sha256sum >/dev/null 2>&1; then
        external "sha256sum is unavailable on the orchestrator host."
    elif [ -f "$WORK_EVIDENCE" ]; then
        EXPECTED="$(sha256sum "$WORK_EVIDENCE" | awk '{print $1}')"
        ACTUAL="$(key_value work_sha256)"
        [ "$ACTUAL" = "$EXPECTED" ] \
            || fail "work_sha256 does not match $WORK.txt. Read the paired evidence before reviewing."
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
    if [ "$WORK" = "contracts-baseline" ]; then
        grep -qF 'src/services/agent/redaction.test.ts' "$EVIDENCE" 2>/dev/null \
            || fail "tests_reviewed must name src/services/agent/redaction.test.ts and its real result."
    fi
}

[ -f "$EVIDENCE" ] || fail "the evidence file $PHASE.txt was not written to \$RUN_DIR"

case "$PHASE" in
    review-*)
        review_gate
        ;;

    contracts-baseline)
        receipt_key gate_installed
        receipt_key tabs_baseline_published
        receipt_key models_verified
        receipt_key tauri_linux_prereqs
        receipt_key toolchain_verified
        [ -f "$REPO_DIR/TABS_WORK_OS_HARNESS_PLAN.md" ] \
            || external "TABS_WORK_OS_HARNESS_PLAN.md is not in the target baseline. Publish the approved baseline."
        need_file src/types/agent.ts
        need_dir src/services/agent
        need_text src/types/agent.ts AgentRun
        need_text src/types/agent.ts AgentToolExecutionAttempt
        need_text src/types/agent.ts AgentApproval
        need_key files
        need_key contract_exports
        need_key tool_versions
        need_key focused_test
        need_value focused_test_exit 0
        need_test_matching src/services/agent
        ;;

    persistence-schema)
        need_file src/services/db.ts
        need_file src/data/crmFormsDb.ts
        need_text src/services/db.ts 'version(13)'
        need_text src/data/crmFormsDb.ts 'version(2)'
        need_text src/services/db.ts agentToolAttempts
        need_text src/services/db.ts taskProjectionJobs
        need_text package.json fake-indexeddb
        need_key schema_versions
        need_key main_tables
        need_key companion_tables
        need_key migration_test
        need_value migration_test_exit 0
        ;;

    credential-migrations)
        need_file src/services/agent/credentialMigration.ts
        need_text src/services/agent/credentialMigration.ts secure
        need_text src/services/agent/credentialMigration.ts migration
        need_key migration_marker
        need_key credential_kinds
        need_key deletion_rule
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    run-repository)
        need_file src/services/agent/runRepository.ts
        need_file src/services/agent/artifactStore.ts
        need_text src/services/agent/runRepository.ts appendEvent
        need_text src/services/agent/runRepository.ts claimRun
        need_text src/services/agent/runRepository.ts checkpoint
        need_key repository_methods
        need_key transaction_invariants
        need_key reload_fixture
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    state-machine-client)
        need_file src/services/agent/runStateMachine.ts
        need_file src/services/agent/agentClient.ts
        need_text src/services/agent/agentClient.ts submitInput
        need_text src/services/agent/agentClient.ts answerApproval
        need_key states
        need_key client_commands
        need_key invalid_cases
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    native-workspace-scope)
        need_file src-tauri/src/agent_tools/scope.rs
        need_text src-tauri/src/agent_tools/scope.rs canonical
        need_text src-tauri/src/lib.rs scope
        need_key rust_commands
        need_key scope_invariants
        need_key escape_cases
        need_key rust_test
        need_value rust_test_exit 0
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

    task-service)
        need_file src/services/tasks/taskService.ts
        need_text src/services/tasks/taskService.ts updatedAt
        need_text src/services/tasks/taskService.ts operationId
        need_key service_commands
        need_key allowed_fields
        need_key receipt_rule
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    task-projection)
        need_file src/services/tasks/taskProjectionWorker.ts
        need_text src/services/tasks/taskProjectionWorker.ts superseded
        need_text src/services/tasks/taskProjectionWorker.ts sourceOperationId
        grep -R -qF 'app_local_data_dir' "$REPO_DIR/src-tauri/src" 2>/dev/null \
            || fail "Rust projection code does not derive the app-local data directory."
        need_key projection_states
        need_key root_rule
        need_key retry_rule
        need_key focused_test
        need_value focused_test_exit 0
        ;;

    crm-forms-commands)
        need_file src/services/crmService.ts
        need_file src/services/formsService.ts
        need_file src/services/submissionService.ts
        need_text src/services/submissionService.ts transaction
        grep -R -qF 'operationId' "$REPO_DIR/src/services" 2>/dev/null \
            || fail "CRM and Forms services contain no operation receipt integration."
        need_key transaction_commands
        need_key duplicate_keys
        need_key validation_rules
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

BASE_PHASE="${PHASE#review-}"
if [ "$BASE_PHASE" = "cutover-release" ]; then
    run_typescript
    run_eslint
    run_vitest_all
    run_vite_build
else
    TEST_FILE="$(test_artifact "$BASE_PHASE")"
    if [ -z "$TEST_FILE" ]; then
        fail "the gate has no focused test mapping for $BASE_PHASE. This is a plan fault."
    else
        run_vitest_file "$TEST_FILE"
    fi
    run_typescript
fi

if [ "$BASE_PHASE" = "contracts-baseline" ]; then
    run_vitest_file 'src/services/agent/redaction.test.ts'
fi

case "$BASE_PHASE" in
    native-workspace-scope|task-projection|desktop-lifecycle|coding-web-hardening|cutover-release)
        run_cargo
        ;;
esac

report
